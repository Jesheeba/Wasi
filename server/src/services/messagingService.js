// Central place any outbound WhatsApp send goes through - chat replies,
// automation-rule actions, and (server/src/services/broadcastRunner.js)
// campaign sends all call this, so the session-window rule and
// sent/failed bookkeeping only exist in one place.
//
// Every function here takes `db` first, forwarded straight through from the
// caller (req.db for a client-authenticated chat reply, the privileged
// `pool` for broadcastRunner/automationEngine) - same convention as the
// repos it calls (see repositories/tagsRepo.js's module comment). The one
// exception is the WABA lookup in getSendableWaba: it always uses the
// privileged `pool` directly, never the passed-in `db`, because
// wabas.access_token_encrypted is revoked from the restricted role at the
// column level (migration 013_tenant_isolation.js) - see wabasRepo.js's
// module comment for the full reasoning.
const wabasRepo = require('../repositories/wabasRepo');
const chatsRepo = require('../repositories/chatsRepo');
const contactsRepo = require('../repositories/contactsRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const subscriptionsRepo = require('../repositories/subscriptionsRepo');
const plansRepo = require('../repositories/plansRepo');
const usageRepo = require('../repositories/usageRepo');
const marketingConsentRepo = require('../repositories/marketingConsentRepo');
const metaClient = require('../utils/metaClient');
const mediaHeaderService = require('./mediaHeaderService');
const { runPaced, isTransientMetaError } = require('../utils/metaSendThrottle');
const messageRetryRepo = require('../repositories/messageRetryRepo');
const { decrypt } = require('../utils/encryption');

const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

class MessagingError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function getSendableWaba(clientId) {
  const waba = await wabasRepo.findByClientId(clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) {
    throw new MessagingError('No connected WhatsApp Business number for this account.', 'waba_not_connected');
  }
  return waba;
}

async function canSendFreeform(db, clientId, chatId) {
  const lastIn = await chatsRepo.lastInboundAt(db, clientId, chatId);
  if (!lastIn) return false;
  return Date.now() - new Date(lastIn).getTime() < SESSION_WINDOW_MS;
}

// Marketing consent gate (build plan Phase 4) - the send path is the
// enforcement point precisely so it can't be bypassed by a different
// caller (chats.js's manual send route, broadcastRunner, or anything
// future) the way a UI-only check could be. Utility and authentication
// templates are exempt; a template whose category can't be determined
// locally is treated as marketing - fail closed, not open.
// Template approval (build-docs/features/template-approval-guard.md). Meta
// only delivers an approved template; a template that is pending, rejected,
// paused or disabled must be refused here with a clear reason, not handed to
// Meta. Exception: an approved template that was edited is 'pending' again,
// but Meta keeps sending the old approved version while it re-reviews, so a
// row that was approved before (approved_at, migration 110) stays sendable
// while pending.
const EDIT_REVIEW_STATUSES = ['pending', 'in_appeal'];

function isTemplateSendable(template) {
  if (!template) return true; // no local row: nothing to check against (the Hub API already refuses this case)
  if (template.status === 'approved') return true;
  return Boolean(template.approved_at) && EDIT_REVIEW_STATUSES.includes(template.status);
}

const STATUS_WORDING = {
  pending: 'is still waiting for Meta\'s review',
  in_appeal: 'is under appeal with Meta',
  rejected: 'was rejected by Meta',
  paused: 'is paused by Meta (low quality rating)',
  disabled: 'is disabled by Meta',
  pending_deletion: 'is being deleted',
};

async function assertTemplateSendable(db, template, accessToken) {
  if (isTemplateSendable(template)) return template;
  // The local row may be stale (a missed status webhook) - ask Meta once
  // before refusing. A failed lookup refuses on the local status.
  if (template.meta_template_id) {
    try {
      const metaStatus = String((await metaClient.getTemplateStatus(template.meta_template_id, accessToken)) || '').toLowerCase();
      if (metaStatus && metaStatus !== template.status) {
        template = (await messageTemplatesRepo.setStatus(db, template.id, metaStatus)) || { ...template, status: metaStatus };
        if (isTemplateSendable(template)) return template;
      }
    } catch (err) {
      console.error('[messagingService] template status re-check failed:', err.message);
    }
  }
  const wording = STATUS_WORDING[template.status] || `has status "${template.status}" on Meta`;
  throw new MessagingError(
    `Template "${template.name}" ${wording}, so it can't be sent yet. Only approved templates can be sent.`,
    'template_not_approved'
  );
}

// Takes the template row directly, not a name - sendChatMessage now looks
// it up once (also needed for the media-header resolution below) rather
// than this function re-fetching it a second time.
//
// Account attestation (build-docs/features/marketing-consent-attestation.md):
// an opted-out contact is always refused; an opted-in one always passes; a
// contact whose status is unknown passes only once the client has attested,
// in Settings > Marketing consent, that it collects opt-in itself.
async function assertConsentForTemplate(db, clientId, chat, template) {
  const requiresConsent = !template || template.category === 'Marketing';
  if (!requiresConsent) return;

  const contact = chat.contact_id ? await contactsRepo.findById(db, clientId, chat.contact_id) : null;
  if (contact?.opt_in_status === 'opted_in') return;
  if (contact?.opt_in_status === 'opted_out') {
    throw new MessagingError(
      'This contact has opted out of marketing messages - only the contact can undo that (e.g. by replying START). Utility/authentication templates are unaffected.',
      'contact_opted_out'
    );
  }
  if (await marketingConsentRepo.isAttested(db, clientId)) return;
  throw new MessagingError(
    'This contact has not opted in to marketing messages. Record their opt-in (Contacts, CSV import, or the API\'s optIn field), or confirm in Settings > Marketing consent that your business collects opt-in. Utility/authentication templates are unaffected.',
    'consent_required'
  );
}

// Approximate plan enforcement - see usageRepo.monthToDateSent for the
// "outbound messages this month" proxy this checks against.
async function assertWithinPlanLimit(db, clientId) {
  const subscription = await subscriptionsRepo.findByClientId(db, clientId);
  if (!subscription || subscription.status !== 'active') return; // no active paid plan to enforce yet - don't block dev/demo use
  const plan = await plansRepo.findById(subscription.plan);
  if (!plan || plan.conversation_limit == null) return; // unlimited (Scale) or unknown plan
  const used = await usageRepo.monthToDateSent(db, clientId);
  if (used >= plan.conversation_limit) {
    throw new MessagingError(
      `Monthly conversation limit reached for the ${subscription.plan} plan (${plan.conversation_limit}/mo). Upgrade to send more.`,
      'plan_limit_reached'
    );
  }
}

// type: 'text' -> { body }. type: 'interactive' -> { body, buttons: [{id,
// title}] } (flowEngine.js's send_interactive_buttons node - see
// metaClient.sendInteractiveMessage; same session-window rule as 'text',
// no template approval). type: 'template' -> { templateName,
// templateLanguage, templateComponents, headerMediaAssetId, headerMediaUrl }.
// headerMediaAssetId (optional, media-header templates only): a specific
// uploaded asset (see templateMediaCacheRepo.insertAsset / migration 030) to
// send instead of the template's approval-time default sample.
// headerMediaUrl (optional, media-header templates only, mutually exclusive
// with headerMediaAssetId - this one wins if somehow both are given): a
// document/image/video the caller hasn't uploaded through this app at all,
// fetched and uploaded to Meta on the fly (see mediaHeaderService's
// resolveMediaIdFromUrl). Exposed today only via the Hub API
// (routes/apiV1Messages.js) for a client's own external CRM to point at.
// connectionHooks ({ release, reacquire }) is only populated by a caller
// holding a single connection across the whole request (routes/chats.js, via
// tenantContext.js's req.db) - callers on the plain `pool` (metaWebhook.js,
// apiV1Messages.js) have nothing to release, since pool.query() already
// acquires/releases per call. When present, release() commits and frees the
// connection right before the Meta network call below and reacquire()
// opens a fresh one only for the final result write, so a slow Meta response
// never pins a connection the pool's other concurrent requests need.
async function sendChatMessage(db, clientId, chat, { type, body, buttons, header, footer, button, sections, templateName, templateLanguage, templateComponents, headerMediaAssetId, headerMediaUrl, limitedTimeOfferExpirationMs, apiKeyId, flow, product, replyToMessageId, retryTransient = true }, connectionHooks = {}) {
  // type 'flow' (WhatsApp Flows / "Forms") is a free-form interactive message
  // too, so it shares the 24h window rule. flow = { metaFlowId, flowToken,
  // cta, screen, mode, name } - see routes/whatsappFlows.js.
  // type 'product' (catalog product messages) likewise; product =
  // { interactive, summary } from utils/productMessages.js.
  if ((type === 'text' || type === 'interactive' || type === 'flow' || type === 'product') && !(await canSendFreeform(db, clientId, chat.id))) {
    throw new MessagingError(
      'This chat is outside the 24-hour customer service window - send a template message instead.',
      'session_window_closed'
    );
  }
  let template = null;
  if (type === 'template') {
    template = await messageTemplatesRepo.findByNameAndClient(db, clientId, templateName);
    await assertConsentForTemplate(db, clientId, chat, template);
  }
  await assertWithinPlanLimit(db, clientId);

  const waba = await getSendableWaba(clientId);
  const accessToken = decrypt(waba.access_token_encrypted);
  // After the WABA lookup because the live re-check needs the token; still
  // before any message row or Meta send.
  if (type === 'template') template = await assertTemplateSendable(db, template, accessToken);
  const toPhone = chat.phone;
  const displayBody = type === 'template' ? `[template: ${templateName}]` : type === 'flow' ? `[form: ${flow.name}] ${body}`
    : type === 'product' ? `[products: ${product.summary}] ${body || ''}`.trim() : body;

  // Resolved before the pending message row exists - same treatment as
  // consent_required/session_window_closed above: a media id that can't be
  // resolved is a pre-flight rejection (nothing was ever attempted with
  // Meta), not a "sent then failed" message bubble.
  let finalComponents = templateComponents || [];
  // Authentication (OTP) templates need the code in BOTH the body and the
  // Copy code button, or Meta rejects with (#131008). The Hub API route has
  // already validated its raw params down to exactly one code and built this
  // pair (routes/apiV1Messages.js); for any other caller the code is lifted
  // from the first body parameter here. Either way it's re-emitted in
  // Meta's required two-component shape and length-checked. Resolved
  // pre-flight, like the media-header check below: a bad code never creates
  // a message row.
  if (type === 'template' && template?.category === 'Authentication') {
    const bodyComponent = finalComponents.find((c) => c.type === 'body');
    const code = bodyComponent?.parameters?.[0]?.text;
    if (!code) {
      throw new MessagingError(
        'This is an Authentication template - pass the one-time code as a param (e.g. params: { "code": "123456" }).',
        'auth_code_required'
      );
    }
    // Meta's documented cap on an Authentication template's code parameter.
    // Checked here so the caller gets a clear error from us instead of a
    // Meta rejection.
    if (code.length > 15) {
      throw new MessagingError(
        `The one-time code is ${code.length} characters - WhatsApp allows at most 15 for an Authentication template.`,
        'auth_code_invalid'
      );
    }
    finalComponents = metaClient.buildAuthenticationSendComponents(code);
  }
  if (type === 'template' && template && mediaHeaderService.isMediaHeaderType(template.header_type)) {
    let resolved;
    try {
      resolved = headerMediaUrl
        ? await mediaHeaderService.resolveMediaIdFromUrl(db, clientId, waba, accessToken, template, headerMediaUrl)
        : await mediaHeaderService.resolveMediaId(db, clientId, waba, accessToken, template, headerMediaAssetId);
    } catch (err) {
      if (err instanceof mediaHeaderService.MediaResolutionError) {
        throw new MessagingError(err.message, 'media_resolution_failed');
      }
      throw err;
    }
    const headerComponent = mediaHeaderService.buildMediaHeaderComponent(template.header_type, resolved.mediaId, resolved.filename);
    finalComponents = [headerComponent, ...finalComponents.filter((c) => c.type !== 'header')];
  }
  // Carousel (build-docs/features/carousel-templates.md) - needs one
  // resolved media id PER CARD, unlike the single-header case above.
  // None of this app's card bodies/buttons carry variables (out of this
  // feature's scope - static text/buttons only), so only each card's
  // header component is dynamic enough to need sending; Meta renders the
  // rest from the approved template itself, same as a static button on
  // any other template never needs its own send-time component.
  if (type === 'template' && template?.cards) {
    let resolvedCards;
    try {
      resolvedCards = await mediaHeaderService.resolveCarouselMediaIds(db, clientId, waba, accessToken, template);
    } catch (err) {
      if (err instanceof mediaHeaderService.MediaResolutionError) {
        throw new MessagingError(err.message, 'media_resolution_failed');
      }
      throw err;
    }
    const carouselComponent = {
      type: 'carousel',
      cards: template.cards.map((card, i) => ({
        card_index: i,
        components: [mediaHeaderService.buildMediaHeaderComponent(card.headerType, resolvedCards[i].mediaId, resolvedCards[i].filename)],
      })),
    };
    finalComponents = [...finalComponents.filter((c) => c.type !== 'carousel'), carouselComponent];
  }
  // Limited-Time-Offer (build-docs/features/limited-time-offer-templates.md).
  // The offer's text/has_expiration are fixed at template-creation time
  // (metaClient.buildUtilityMarketingPayload), but Meta requires the actual
  // expiration moment to be supplied fresh on every send - the same
  // approved template is reused across many sends/broadcasts with
  // different sale windows, so it can't be baked in once. Resolved
  // pre-flight, same as the Authentication-code and media-header checks
  // above: a missing expiry never creates a message row.
  if (type === 'template' && template?.limited_time_offer?.hasExpiration) {
    if (!limitedTimeOfferExpirationMs) {
      throw new MessagingError(
        'This is a Limited-Time-Offer template with an expiration - pass limitedTimeOfferExpirationMs (the offer\'s expiry as a Unix ms timestamp).',
        'limited_time_offer_expiration_required'
      );
    }
    finalComponents = [
      ...finalComponents.filter((c) => c.type !== 'limited_time_offer' && !(c.type === 'button' && c.sub_type === 'copy_code')),
      // Number(): a bigint column (broadcasts.limited_time_offer_expiration_ms)
      // comes back from pg as a string, not a number - Meta's API expects a
      // numeric timestamp either way.
      { type: 'limited_time_offer', parameters: [{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: Number(limitedTimeOfferExpirationMs) } }] },
      // Required alongside limited_time_offer at send time too (confirmed
      // against Meta's docs) - the coupon_code parameter is dynamic per
      // send, same as expiration_time_ms, even though this app always
      // reuses the template's own fixed offer code rather than offering a
      // per-send-different one (no UI for that - out of this feature's
      // scope).
      { type: 'button', sub_type: 'copy_code', index: '0', parameters: [{ type: 'coupon_code', coupon_code: template.limited_time_offer.code }] },
    ];
  }

  // Reply/quote (2026-11-23) - resolved before the pending message row is
  // created, same pre-flight-check placement as the media-header/auth-code
  // checks above, scoped to this chat/client so one chat's message id can
  // never be used to reply "into" another chat. A target that doesn't
  // resolve (wrong id, already-deleted-in-theory row, wrong chat) is
  // silently treated as "not a reply" rather than rejecting the whole
  // send - replying is a nice-to-have on top of an otherwise-normal
  // message, not a hard requirement of it.
  let replyContextMessageId = null;
  if (type === 'text' && replyToMessageId) {
    const replyTarget = await chatsRepo.findMessageByIdForClient(db, clientId, replyToMessageId);
    if (replyTarget && replyTarget.chat_id === chat.id && replyTarget.meta_message_id) {
      replyContextMessageId = replyTarget.meta_message_id;
    }
  }

  const message = await chatsRepo.insertOutboundPending(db, clientId, chat.id, displayBody, apiKeyId || null, replyContextMessageId ? replyToMessageId : null);

  if (connectionHooks.release) await connectionHooks.release();

  // The Meta call as data ({fn, args} - never the access token), so a send
  // that hits a network or temporary Meta error can be queued and replayed
  // exactly (build-docs/features/send-retry-queue.md, messageRetryRunner).
  let call;
  if (type === 'text') {
    call = { fn: 'sendTextMessage', args: [toPhone, body, replyContextMessageId] };
  } else if (type === 'product') {
    call = { fn: 'sendProductMessage', args: [toPhone, product.interactive] };
  } else if (type === 'flow') {
    call = {
      fn: 'sendFlowMessage',
      args: [toPhone, {
        bodyText: body, cta: flow.cta, flowId: flow.metaFlowId, flowToken: flow.flowToken, screen: flow.screen, mode: flow.mode,
        action: flow.action,
      }],
    };
  } else if (type === 'interactive') {
    // Two distinct interactive shapes share type: 'interactive' - a
    // reply-button message (buttons) or a list message (sections),
    // decided by which one is present. validate.js's apiMessageSendSchema
    // already guarantees exactly one of them is set before this is ever
    // reached, so no third "neither/both" case needs handling here.
    call = sections
      ? { fn: 'sendListMessage', args: [toPhone, { bodyText: body, buttonText: button, sections, header, footer }] }
      : { fn: 'sendInteractiveMessage', args: [toPhone, { bodyText: body, buttons, header, footer }] };
  } else {
    // `template.language` (the real local row) wins over the caller-supplied
    // `templateLanguage`, which is only the fallback when no local row exists
    // - a stale caller value would otherwise reach Meta as the wrong language.
    // Marketing templates go through the Marketing Messages API when an
    // admin switched it on for this client (marketing-messages-api.md).
    const route = waba.mm_api_enabled && template?.category === 'Marketing' ? 'mm_api' : undefined;
    call = {
      fn: 'sendTemplateMessage',
      args: [toPhone, {
        name: templateName, language: template?.language || templateLanguage, components: finalComponents,
        ...(route ? { route, activitySharing: waba.mm_activity_sharing === true } : {}),
      }],
    };
  }

  let metaMessageId;
  try {
    // Paced per WhatsApp number; transient errors retried inline
    // (utils/metaSendThrottle.js). retryTransient: false for broadcasts,
    // which reschedule a transient failure themselves.
    metaMessageId = await runPaced(waba.phone_number_id,
      () => metaClient[call.fn](waba.phone_number_id, accessToken, ...call.args),
      { retry: retryTransient });
  } catch (err) {
    console.error(
      `messagingService.sendChatMessage: send failed - client=${clientId} message=${message.id} phoneNumberId=${waba.phone_number_id}:`,
      err.metaError || err.message
    );
    if (connectionHooks.reacquire) db = await connectionHooks.reacquire();
    // Not the message's fault (network, timeout, temporary Meta error): keep
    // it 'pending' and queue it for the background retry instead of losing
    // it. Returned like a success, marked `queued` - the Hub API answers 202.
    if (retryTransient && isTransientMetaError(err)) {
      const queued = await messageRetryRepo.queue(db, clientId, message.id, call, `Queued for retry: ${err.message}`);
      if (queued) return { ...queued, queued: true };
    }
    await chatsRepo.markFailed(db, clientId, message.id, err.message, err.metaError?.code, err.metaError?.error_subcode);
    // Commits the failure write right here, on this connection, before
    // returning control to the route - NOT left for the response's own
    // finalize(res.statusCode < 500) to decide. A 502 for a "send_failed"
    // MessagingError is exactly what that blanket rule reads as an aborted
    // transaction and rolls back, which is what silently discarded this
    // exact write in production (bug found 18 Sep 2026, present since
    // b9affd5): the row stayed 'pending' forever with meta_error_code null,
    // even though this line had already run and returned successfully.
    if (connectionHooks.release) await connectionHooks.release();
    const sendError = new MessagingError(err.message, 'send_failed');
    // Carries Meta's raw error object through, if this failure came from a
    // real Graph API rejection (see metaClient.js's graphFetch) - the hub
    // API surfaces it; the internal chat-send route ignores the extra field.
    sendError.metaError = err.metaError || null;
    throw sendError;
  }

  // Meta already accepted the message by this point - anything that goes
  // wrong from here (reacquiring a connection, the bookkeeping writes) must
  // never be reported as a failed SEND, since it really did go out. Left
  // deliberately unguarded (no catch-and-mark-failed here): a bookkeeping
  // error surfaces as a plain 500, distinct from send_failed, rather than
  // lying to the caller that the message never reached the recipient.
  if (connectionHooks.reacquire) db = await connectionHooks.reacquire();
  const sent = await chatsRepo.markSent(db, clientId, message.id, metaMessageId, call.args[1]?.route);
  await usageRepo.incrementSent(db, clientId);
  return sent;
}

// Re-attempts a previously failed send using its original text body. Only
// supports retrying free-form text (the common failed case - a transient
// Cloud API error); a template retry should go through sendChatMessage again
// with the template explicitly, since we don't persist which template a
// message used.
// Matches the exact placeholder sendChatMessage's displayBody builds for a
// template send (`[template: ${templateName}]`) - template names are
// restricted to lowercase/digits/underscore by messageTemplateCreateSchema,
// so this can't false-positive on a real customer-facing text message that
// merely starts with a literal "[template:" (that's not realistic sendable
// text to begin with, but the anchored full-string match rules it out either
// way).
const TEMPLATE_PLACEHOLDER_BODY_RE = /^\[template: ([a-z0-9_]+)\]$/;

async function retryMessage(db, clientId, chat, message, connectionHooks = {}) {
  if (message.status !== 'failed') {
    throw new MessagingError('Only a failed message can be retried.', 'not_failed');
  }
  // Found live 2026-11-04 (TNPSC Mentors): this function's own top-of-file
  // comment already documented the limitation ("we don't persist which
  // template a message used") but nothing actually enforced it - a failed
  // template send's row has no `type` column to tell retryMessage apart
  // from a failed plain-text send, and without this check it fell through
  // to sendTextMessage(..., message.body) below, which for a template is
  // literally the internal placeholder string `[template: <name>]` - sent,
  // delivered, and read by a real customer as that exact literal text.
  // Confirmed in production, not theoretical. There's no schema to properly
  // re-run the original template (parameters aren't persisted either), so
  // this refuses cleanly instead of guessing at a fix that could itself
  // send something wrong.
  const templateMatch = message.body?.match(TEMPLATE_PLACEHOLDER_BODY_RE);
  if (templateMatch) {
    throw new MessagingError(
      `This was a template message ("${templateMatch[1]}"), not plain text - Retry can't resend it correctly. Open Templates and send "${templateMatch[1]}" again instead.`,
      'cannot_retry_template'
    );
  }
  // Same trap for a failed form send: its body is the "[form: <name>] ..."
  // placeholder, which must never go out as plain text.
  const formMatch = /^\[(?:form|products): ([^\]]+)\]/.exec(message.body || '');
  if (formMatch) {
    throw new MessagingError(
      `This was a form or product message ("${formMatch[1]}"), not plain text - Retry can't resend it. Send it again from the chat menu instead.`,
      'cannot_retry_form'
    );
  }
  if (!(await canSendFreeform(db, clientId, chat.id))) {
    throw new MessagingError(
      'This chat is outside the 24-hour customer service window - send a template message instead.',
      'session_window_closed'
    );
  }

  const waba = await getSendableWaba(clientId);
  const accessToken = decrypt(waba.access_token_encrypted);

  if (connectionHooks.release) await connectionHooks.release();

  let metaMessageId;
  try {
    metaMessageId = await runPaced(waba.phone_number_id, () => metaClient.sendTextMessage(waba.phone_number_id, accessToken, chat.phone, message.body));
  } catch (err) {
    console.error(
      `messagingService.retryMessage: retry failed - client=${clientId} message=${message.id} phoneNumberId=${waba.phone_number_id}:`,
      err.metaError || err.message
    );
    if (connectionHooks.reacquire) db = await connectionHooks.reacquire();
    await chatsRepo.markFailed(db, clientId, message.id, err.message, err.metaError?.code, err.metaError?.error_subcode);
    // Same commit-before-throw reasoning as sendChatMessage's catch above -
    // see that comment for the full bug writeup.
    if (connectionHooks.release) await connectionHooks.release();
    const sendError = new MessagingError(err.message, 'send_failed');
    sendError.metaError = err.metaError || null;
    throw sendError;
  }

  if (connectionHooks.reacquire) db = await connectionHooks.reacquire();
  return chatsRepo.markSent(db, clientId, message.id, metaMessageId);
}

// Sends (or, with emoji='', removes) an agent-side reaction to a specific
// message in this chat - a lightweight interaction, not a new message, so
// it deliberately does not go through sendChatMessage's full pipeline
// (consent checks, plan-limit checks, a pending/sent message row of its
// own). Still gated by the same 24h customer-service window as any other
// free-form send - confirmed against Meta's docs, reactions are not
// exempt from it. `messageId` is the LOCAL message row being reacted to;
// its own meta_message_id (the wamid) is what Meta actually needs.
async function sendReactionToMessage(db, clientId, chat, messageId, emoji) {
  if (!(await canSendFreeform(db, clientId, chat.id))) {
    throw new MessagingError(
      'This chat is outside the 24-hour customer service window - reactions can only be sent inside it.',
      'session_window_closed'
    );
  }
  const target = await chatsRepo.findMessageByIdForClient(db, clientId, messageId);
  if (!target || target.chat_id !== chat.id || !target.meta_message_id) {
    throw new MessagingError('That message could not be found in this chat.', 'message_not_found');
  }

  const waba = await getSendableWaba(clientId);
  const accessToken = decrypt(waba.access_token_encrypted);
  try {
    await metaClient.sendReaction(waba.phone_number_id, accessToken, chat.phone, target.meta_message_id, emoji);
  } catch (err) {
    const sendError = new MessagingError(err.message, 'send_failed');
    sendError.metaError = err.metaError || null;
    throw sendError;
  }
  return chatsRepo.setReaction(db, clientId, target.id, 'agent', emoji);
}

module.exports = { MessagingError, canSendFreeform, isTemplateSendable, sendChatMessage, retryMessage, sendReactionToMessage, SESSION_WINDOW_MS };
