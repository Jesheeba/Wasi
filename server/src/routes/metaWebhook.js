const { Router } = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const auditLogRepo = require('../repositories/auditLogRepo');
const wabasRepo = require('../repositories/wabasRepo');
const contactsRepo = require('../repositories/contactsRepo');
const chatsRepo = require('../repositories/chatsRepo');
const paymentNotificationsRepo = require('../repositories/paymentNotificationsRepo');
const consentRepo = require('../repositories/consentRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const { mapMetaCategory } = require('../services/templateSyncService');
const usageRepo = require('../repositories/usageRepo');
const clientWebhooksRepo = require('../repositories/clientWebhooksRepo');
const webhookDeliveriesRepo = require('../repositories/webhookDeliveriesRepo');
const messageStatusForwardsRepo = require('../repositories/messageStatusForwardsRepo');
const zapierSubscriptionsRepo = require('../repositories/zapierSubscriptionsRepo');
const whatsappFlowsRepo = require('../repositories/whatsappFlowsRepo');
const flowTemplates = require('../utils/whatsappFlowTemplates');
const productMessages = require('../utils/productMessages');
const contactAttributeValuesRepo = require('../repositories/contactAttributeValuesRepo');
const { validateContactAttributeValue } = require('../utils/validate');
const flowEngine = require('../services/flowEngine');
const aiAgentRunner = require('../services/aiAgentRunner');
const forwardRunner = require('../services/forwardRunner');
const { isOptOutMessage, isOptInMessage } = require('../utils/optOutKeywords');
const { asyncHandler } = require('../utils/asyncHandler');

const router = Router();

// Meta's verification handshake when you register this URL in the App Dashboard.
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Meta signs every webhook delivery with an HMAC-SHA256 of the raw body,
// keyed by the app secret - verifying this is what proves a payload actually
// came from Meta and wasn't forged by hitting this public URL directly.
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.META_APP_SECRET;
  if (!secret || !signatureHeader || !rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// Enqueues one delivery per configured forward target for this waba's
// client that has actually subscribed to this event, into the same
// durable, retried queue (build plan Phase 5) - wabas.forward_to_url (a
// hub-connected consuming app) and client_webhooks.callback_url (the
// client's own generic integration webhook, Settings > Webhook) are
// independent, optional targets, and a client can have either, both, or
// neither configured. This replaces what used to be two separate
// mechanisms: this enqueue for the hub target, and a fire-and-forget fetch
// with no retry for the client's own webhook.
//
// Event selection is explicit per target (migration
// 015_explicit_forward_events.js), not implicit - each target declares
// its own `events` array at configuration time (routes/clientWebhook.js,
// routes/admin.js's hub-forward config) and only receives events it's
// actually listed. This was a real gap in the initial unification: it
// widened client_webhooks from message.received-only to silently
// receiving all three event types with no way to opt out, which would
// have been a breaking contract change for an existing subscriber (none
// existed yet, confirmed live before this fix - but the next one would
// have hit it). Signed identically for both targets
// (x-wasi-signature-256, HMAC-SHA256 of the JSON body), so nothing about
// how a receiving app verifies a delivery changes based on which target
// or which events it's configured for.
async function enqueueForwards(waba, event, payload) {
  // waba_id/enqueued_at added here, once, so every event type (message.received,
  // message.status, message_template_status_update, account_update) and every
  // target (hub forward_to_url, client_webhooks) gets them uniformly without
  // each handler assembling its own envelope fields. enqueued_at is when this
  // event was received/enqueued, not when a delivery attempt fires - stable
  // across forwardRunner.js's retries, not re-stamped per attempt. Named
  // enqueued_at rather than timestamp so it can't be confused with
  // message.received's own message.sent_at in the same payload.
  const envelopeData = { ...payload, waba_id: waba.waba_id, enqueued_at: new Date().toISOString() };

  if (waba.forward_to_url && waba.forward_events?.includes(event)) {
    const delivery = await webhookDeliveriesRepo.enqueue(pool, {
      clientId: waba.client_id,
      wabaId: waba.id,
      event,
      payload: envelopeData,
      targetUrl: waba.forward_to_url,
      targetSecret: waba.forward_secret,
    });
    forwardRunner.attemptImmediately(delivery);
  }

  let clientWebhook;
  try {
    clientWebhook = await clientWebhooksRepo.findByClientId(pool, waba.client_id);
  } catch (err) {
    console.error('metaWebhook: failed to look up client_webhooks for', waba.client_id, err.message);
    clientWebhook = null;
  }
  if (clientWebhook && clientWebhook.events?.includes(event)) {
    const delivery = await webhookDeliveriesRepo.enqueue(pool, {
      clientId: waba.client_id,
      wabaId: waba.id,
      event,
      payload: envelopeData,
      targetUrl: clientWebhook.callback_url,
      targetSecret: clientWebhook.secret,
    });
    forwardRunner.attemptImmediately(delivery);
  }

  // Zapier's "New WhatsApp Message Received" trigger (build plan Phase 4,
  // wasi-master-plan.md §3.1) - unlike the two targets above, a client can
  // have several of these active at once (one per Zap), so this is a list,
  // not a single lookup. Same enqueue call, same downstream queue/runner -
  // Zapier's subscription is just a third source feeding it.
  let zapierSubscriptions;
  try {
    zapierSubscriptions = await zapierSubscriptionsRepo.listByClientAndEvent(pool, waba.client_id, event);
  } catch (err) {
    console.error('metaWebhook: failed to look up zapier_subscriptions for', waba.client_id, err.message);
    zapierSubscriptions = [];
  }
  for (const subscription of zapierSubscriptions) {
    const delivery = await webhookDeliveriesRepo.enqueue(pool, {
      clientId: waba.client_id,
      wabaId: waba.id,
      event,
      payload: envelopeData,
      targetUrl: subscription.target_url,
      targetSecret: subscription.secret,
    });
    forwardRunner.attemptImmediately(delivery);
  }
}

// A completed WhatsApp Form arrives as interactive.nfm_reply, with the
// answers in response_json (a JSON *string*) and no flow id - Wasi puts its
// own form id in flow_token (whatsappFlowTemplates.makeFlowToken). Returns
// null for any other message. Never throws: a malformed reply or a failed
// lookup still lets the message itself be stored (as "Form submitted").
async function parseFormReply(clientId, msg) {
  const nfm = msg.interactive?.nfm_reply;
  if (!nfm) return null;
  let response = {};
  try { response = JSON.parse(nfm.response_json || '{}') || {}; } catch { response = {}; }
  const flowToken = typeof response.flow_token === 'string' ? response.flow_token : null;
  let flow = null;
  const flowId = flowTemplates.flowIdFromToken(flowToken);
  if (flowId) {
    try { flow = await whatsappFlowsRepo.findById(pool, clientId, flowId); } catch (err) {
      console.error('metaWebhook: form lookup failed (reply still stored):', err.message);
    }
  }
  const answers = flowTemplates.describeResponse(flow, response);
  const title = flow ? `Form submitted: ${flow.name}` : 'Form submitted';
  const lines = answers.map((a) => `${a.label}: ${a.value}`);
  const body = [title, ...lines].join('\n');
  return { flow, flowToken, response, body };
}

// Forms phase 3: copy answers onto the contact's fields, per the form's
// attribute_map. Same rule as the flow engine's Capture Reply: an answer
// that doesn't fit the field's type (e.g. text into a number field) is
// skipped, never stored.
async function applyFormAnswersToContact(clientId, contactId, formReply) {
  const map = formReply.flow?.attribute_map || {};
  if (!Object.keys(map).length) return;
  const answers = Object.fromEntries(flowTemplates.describeResponse(formReply.flow, formReply.response).map((a) => [a.key, a.value]));
  const { rows } = await pool.query('select id, type from contact_attributes where client_id = $1 and id = any($2::uuid[])', [clientId, Object.values(map)]);
  const types = Object.fromEntries(rows.map((r) => [r.id, r.type]));
  for (const [field, attributeId] of Object.entries(map)) {
    const value = String(answers[field] ?? '').trim();
    if (!value || !types[attributeId] || !validateContactAttributeValue(types[attributeId], value)) continue;
    await contactAttributeValuesRepo.upsert(pool, clientId, contactId, attributeId, value);
  }
}

// New customer message: upsert the contact, find/open their chat, insert
// (idempotent on Meta's message id), then let automation rules react.
// Takes the resolved waba row (not just clientId) - build plan Phase 5's
// hub forwarding needs waba.forward_to_url/forward_secret/id, which the
// caller already has from wabasRepo.findByWabaId and shouldn't re-fetch.
async function handleInboundMessages(waba, value) {
  const clientId = waba.client_id;
  const contactInfo = value.contacts?.[0];
  for (const msg of value.messages || []) {
    const phone = msg.from;
    const name = contactInfo?.profile?.name || phone;

    // Emoji reactions (2026-11-23) - a genuinely separate inbound event
    // shape (Meta's documented type:'reaction'), not a message with a body
    // of its own: msg.reaction.{message_id, emoji}, message_id is the
    // wamid of the message being reacted to, emoji is '' when the customer
    // removed their reaction. Updates the target row in place rather than
    // inserting a new messages row - there is nothing to insert, Meta
    // never attaches a reaction's own id to anything this app would want
    // to reference later the way a real message's wamid is used elsewhere.
    // Scope note: a reaction to a message this app never saw (predates
    // this feature, or targets a different client's chat entirely) finds
    // nothing to update and is silently dropped - the same "harmless no-op
    // on an unresolvable target" treatment the reply-context lookup below
    // gets, not an error.
    if (msg.type === 'reaction') {
      const target = await chatsRepo.findByMetaMessageId(pool, clientId, msg.reaction?.message_id);
      if (target) await chatsRepo.setReaction(pool, clientId, target.id, 'customer', msg.reaction?.emoji || '');
      continue;
    }

    // Free-form interactive button replies (see metaClient.sendInteractiveMessage)
    // come back as msg.interactive.button_reply.{id,title} - title is what a
    // human reads in the chat; id is the stable value the flow engine
    // branches on (routes/flowEngine.js), never re-derived from title here.
    const buttonReply = msg.interactive?.button_reply;
    // A tap on a list-message row - msg.interactive.list_reply.{id,title,
    // description}, Meta's other interactive reply shape alongside
    // button_reply above. Never received live yet (no metaClient function
    // builds a list message to send in the first place - see
    // metaClient.sendListMessage), so this is doc-shape, not
    // capture-verified the way button_reply now is; still routed the same
    // way rather than left as the old "[interactive]" fallback that
    // silently discarded id/title/description entirely.
    const listReply = msg.interactive?.list_reply;
    // Template quick-reply clicks (type: "button") are a separate shape -
    // msg.button.{text,payload} - from the flow-builder's own interactive
    // buttons above. Reading .text here is what lets an automation rule's
    // trigger keyword match the button's label (e.g. "Received").
    const templateButtonText = msg.button?.text;
    const formReply = await parseFormReply(clientId, msg);
    // request_welcome: sent when a customer opens a new chat while the
    // welcome message is on (whatsapp-quick-wins.md); shown as plain words.
    const welcomeOpen = msg.type === 'request_welcome' ? 'Opened the chat' : null;
    // A cart the customer sent from the catalog (type "order"), as readable
    // text (catalog-product-messages.md).
    const cartText = msg.type === 'order' && msg.order ? productMessages.describeOrder(msg.order) : null;
    const body = msg.text?.body || formReply?.body || buttonReply?.title || listReply?.title || templateButtonText || welcomeOpen || cartText || `[${msg.type}]`; // MVP: other non-text types still render as a type tag

    // Forwarded verbatim alongside `body` in message.received (see below) -
    // body alone only ever carried the reply's title (e.g. "Yes"), never
    // its id (e.g. "flow_test_yes") or, for a list row, its description -
    // the stable values a receiving CRM needs to route on programmatically
    // rather than parsing display text. null for a non-interactive message,
    // kept as an explicit field (not omitted) so a receiving CRM can always
    // check it rather than guess whether an absent key means "not
    // interactive" or "never sent."
    const interactiveReply = buttonReply
      ? { type: 'button_reply', id: buttonReply.id, title: buttonReply.title }
      : listReply
        ? { type: 'list_reply', id: listReply.id, title: listReply.title, description: listReply.description ?? null }
        : formReply
          // A completed form: the raw answers plus the token Wasi sent, so a
          // receiving CRM can use them directly.
          ? { type: 'nfm_reply', flow_token: formReply.flowToken, response: formReply.response }
          : null;

    // Capture-and-verify: interactive.button_reply's exact shape (id/title
    // field names, whether other fields are present) was inferred from
    // Meta's docs, not confirmed against a live payload the way
    // messages/statuses now have been (see this file's other
    // "not doc-confirmed" comments for the established pattern). Recorded
    // unconditionally so the real shape can be checked via audit_log
    // without VPS log access, same reasoning as handleAccountUpdate's
    // restriction_info capture below.
    if (msg.type === 'interactive') {
      await auditLogRepo.record({
        actor_type: 'meta_webhook',
        actor_id: null,
        action: 'interactive_message_received',
        target: `${phone}: ${JSON.stringify(msg.interactive).slice(0, 500)}`,
      });
    }
    if (msg.type === 'button') {
      await auditLogRepo.record({
        actor_type: 'meta_webhook',
        actor_id: null,
        action: 'template_button_received',
        target: `${phone}: ${JSON.stringify(msg.button).slice(0, 500)}`,
      });
    }

    const contact = await contactsRepo.upsertByPhone(pool, clientId, { phone, name, wa_id: phone });
    const chat = await chatsRepo.findOrCreateByContact(pool, clientId, contact);
    // PLAN.md item 14 - msg.referral (Meta's documented CTWA ad-click
    // object, §6.2) is present only when this inbound message originated
    // from a Click-to-WhatsApp ad; undefined/absent for every organic
    // message. Parsing an already-arrived inbound webhook payload, not a
    // call to Meta.
    // Reply/quote (2026-11-23) - msg.context.id is Meta's documented wamid
    // of the message being replied to, present whenever the customer tapped
    // Reply on a specific message in WhatsApp. Resolved to this tenant's own
    // local row before insert, same lookup reaction handling below reuses -
    // absent entirely for an ordinary (non-reply) message, and harmless
    // (stores null) if the target was never seen by this app for any
    // reason (a message that predates this feature, or arrived out of
    // order).
    const replyToMessage = msg.context?.id ? await chatsRepo.findByMetaMessageId(pool, clientId, msg.context.id) : null;
    const inserted = await chatsRepo.insertInbound(pool, clientId, chat.id, {
      metaMessageId: msg.id,
      body,
      sentAt: msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : null,
      referral: msg.referral || null,
      replyToMessageId: replyToMessage?.id || null,
    });

    if (inserted) {
      await usageRepo.incrementReceived(pool, clientId);

      // Completed form -> whatsapp_flow_responses. Isolated like the blocks
      // below: the message insert is idempotent, so a throw here would make
      // Meta's retry skip forwarding for good. The response insert is itself
      // idempotent on the Meta message id.
      if (formReply) {
        try {
          await whatsappFlowsRepo.recordResponse(pool, {
            clientId, flowId: formReply.flow?.id || null, chatId: chat.id, contactId: contact.id,
            metaMessageId: msg.id, flowToken: formReply.flowToken, response: formReply.response,
          });
        } catch (err) {
          console.error('metaWebhook: storing form response failed (message itself is stored):', { clientId, metaMessageId: msg.id, error: err.message });
        }
        try {
          await applyFormAnswersToContact(clientId, contact.id, formReply);
        } catch (err) {
          console.error('metaWebhook: saving form answers to contact fields failed:', { clientId, metaMessageId: msg.id, error: err.message });
        }
      }

      // Opt-out (build plan Phase 4) - recorded before automation runs, so
      // the consent_events row exists regardless of whatever a client's own
      // automation rules do with this same inbound message.
      //
      // Isolated for the same reason flowEngine.evaluate() below is: the
      // insert above is idempotent on meta_message_id, so an uncaught throw
      // here would 500 (Meta retries) but the retry's insert becomes a
      // no-op, permanently skipping this whole block - including
      // enqueueForwards - with no way to ever recover it. recordOptOutDurable
      // never throws (consent hardening Phase 1 - see its own comment in
      // consentRepo.js): it retries once, and on repeated failure writes a
      // durable fallback row and raises an alert instead of losing the
      // opt-out to a log line, which is what this used to do.
      if (isOptOutMessage(body)) {
        // phone passed explicitly (not just inside evidence) so
        // recordOptOutDurable's own last-resort log line is guaranteed to
        // have it even if a future caller's evidence shape omits it -
        // see that function's own comment for why this can't rely on
        // evidence's contents.
        await consentRepo.recordOptOutDurable(clientId, contact.id, {
          source: 'inbound_stop_keyword',
          phone,
          evidence: { message_id: inserted.id, meta_message_id: msg.id, body },
        });
      }

      // Opt-in (build plan Phase 4, approved in CLAUDE.md's Known Gaps) -
      // the contact's own inbound START is the one path allowed to lift a
      // sticky opt-out (consentRepo.recordOptInDurable passes
      // allowOverrideOptOut: true internally - not available to any other
      // caller). Mutually exclusive with the STOP branch above: the two
      // keyword lists don't overlap, so a given inbound body matches at
      // most one of them.
      if (isOptInMessage(body)) {
        await consentRepo.recordOptInDurable(clientId, contact.id, {
          source: 'inbound_start_keyword',
          phone,
          evidence: { message_id: inserted.id, meta_message_id: msg.id, body },
        });
      }

      // Isolated so a bug in a client's own automation rules can never
      // silently kill forwarding for this message: same idempotent-insert
      // trap as the opt-out block above - an uncaught throw here would 500
      // and make Meta retry, but the retry's insert is a no-op, so
      // enqueueForwards below would never run again for this message. A
      // receiving CRM silently losing an inbound message is worse than one
      // client's automation rule silently not firing once, so this
      // deliberately does NOT re-throw - do not "simplify" this away.
      //
      // evaluateSafely never throws: it returns the outcome ({handled, how},
      // flowEngine.js's table), with a throw reported as how:'flow_error'.
      // The outcome is what the AI agent's gate 5 will read (docs/ai-agent,
      // unit 0.4 wires the enqueue); nothing consumes it yet, so today this
      // is behaviourally identical to the try/catch it replaced.
      const flowOutcome = await flowEngine.evaluateSafely(pool, clientId, contact, chat, msg, body);
      if (flowOutcome.how === 'flow_error') {
        console.error('metaWebhook: flowEngine.evaluate FAILED - forwarding continues regardless:', {
          clientId, metaMessageId: msg.id, error: flowOutcome.error,
        });
      }

      // AI agent (docs/ai-agent unit 0.4): hand the message to the agent's
      // queue ONLY when the flow/automation layer left it alone. The decision
      // is flowEngine.agentMayAnswer (inside enqueueIfEligible), never
      // `!flowOutcome.handled`: an active flow that recognised nothing and a
      // flow-engine failure are both handled:false and both must stay silent.
      // Isolated for the same reason as the blocks above: the message insert
      // is idempotent, so an uncaught throw would 500, Meta would retry, the
      // retry's insert would be a no-op and enqueueForwards below would be
      // skipped for good. Fire-and-forget past the enqueue itself (the
      // runner's attemptImmediately is never awaited). For every client today
      // this is a no-op: no client is eligible until the agent exists.
      try {
        await aiAgentRunner.enqueueIfEligible({
          clientId, conversationId: chat.id, inboundMessageId: inserted.id, flowOutcome,
        });
      } catch (err) {
        console.error('metaWebhook: AI agent enqueue FAILED - forwarding continues regardless:', {
          clientId, metaMessageId: msg.id, error: err.message,
        });
      }

      // This only enqueues; forwardRunner.js does the actual delivery
      // attempt(s), on its own schedule, outside this request entirely -
      // see its module comment for why that separation is load-bearing,
      // not just tidy.
      //
      // message_id is promoted out of `inserted` to match message.status
      // forwards' top-level field of the same name (fix #2) - meta_message_id
      // is the real WhatsApp id, id/client_id are Wasi-internal PKs a
      // receiving CRM has no use for and shouldn't see. status is dropped
      // entirely (not renamed) - chatsRepo.insertInbound hardcodes it to
      // 'delivered' for every inbound row (it's a DB-write confirmation, not
      // a real WhatsApp delivery status), so forwarding it would mislead a
      // CRM into reading it as one. message.status forwards (handleStatuses)
      // carry Meta's real, meaningful status and are untouched by this.
      // direction is dropped too - always 'in' on this event type (only
      // inbound messages reach this handler), so it's pure redundancy with
      // the event name itself. error_reason/meta_error_code are dropped -
      // both columns are shared with outbound-send-failure rows in this same
      // messages table and are always null on an inbound row; forwarding
      // them here would just be two guaranteed-null fields. referral is
      // dropped too - a real regression, caught by this file's own key-set
      // test (webhookForwarding.test.js:168): PLAN.md item 14 added
      // messages.referral, and without this exclusion it leaked into every
      // message.received delivery (as `referral: null` on every ordinary
      // message, not just CTWA-sourced ones), silently widening this
      // external wire contract. CTWA attribution was only ever meant to
      // land in item 14's own surfaces (the Contact 360 timeline, GET
      // /api/analytics/ctwa) - a receiving CRM getting it via forwarding too
      // is a real, separate scope decision, not a byproduct of adding a
      // column. See CLAUDE.md's webhook-contract note: every future
      // migration adding a `messages` column must be checked against this
      // destructure, since a new column's default behavior is to leak here
      // silently - this exact test only caught it because someone happened
      // to write a key-set assertion, not because the destructure itself
      // guards against it. delivered_at/read_at/failed_at (migration
      // 072_messages_status_timestamps.js) are dropped for the same reason
      // as error_reason/meta_error_code above - they're stamped by
      // chatsRepo.updateStatusByMetaId on an outbound message's delivery
      // lifecycle and are always null on an inbound row. meta_error_subcode
      // (073_messages_error_subcode.js) is dropped for the identical reason
      // as meta_error_code itself - same table, same outbound-only column,
      // always null here.
      const {
        id, client_id, chat_id: _chatId, meta_message_id, status: _hardcodedStatus,
        direction: _direction, error_reason: _errorReason, meta_error_code: _metaErrorCode,
        meta_error_subcode: _metaErrorSubcode,
        referral: _referral, delivered_at: _deliveredAt, read_at: _readAt, failed_at: _failedAt,
        // Outbound-only retry queue (migration 113) - always defaults on an
        // inbound row, and internal state, never part of the external contract.
        retry_count: _retryCount, next_retry_at: _nextRetryAt, send_request: _sendRequest,
        // source (migration 080_messages_source.js) is dropped for the same
        // reason as direction above - chatsRepo.insertInbound never sets it,
        // so it's always the column default ('api') on every inbound row,
        // pure redundancy with the event name itself. Real signal (an
        // echo's 'whatsapp_app') only ever appears on an OUTBOUND row from
        // handleMessageEchoes, which this destructure never runs against -
        // per CLAUDE.md's own webhook-contract convention, this is a
        // deliberate exclusion decision, not a byproduct of adding the
        // column.
        source: _source,
        // api_key_id (migration 090_messages_api_key_id.js) - internal
        // attribution only (which Hub API key sent an outbound message);
        // always null on an inbound row anyway, but excluded on principle
        // per this file's own webhook-contract convention rather than
        // relying on that.
        api_key_id: _apiKeyId,
        // reply_to_message_id (migration 102) is a Wasi-internal message
        // PK, same exclusion reasoning as id/chat_id above - meaningless to
        // an external consumer without a Wasi-internal id to resolve it
        // against. The two reaction columns are always null on THIS row
        // (a reaction is its own separate inbound event type, never part
        // of a text/media message's own insert) - same "always null here,
        // pure noise" reasoning as error_reason/meta_error_code.
        reply_to_message_id: _replyToMessageId,
        customer_reaction_emoji: _customerReactionEmoji,
        agent_reaction_emoji: _agentReactionEmoji,
        // send_route (migration 114) - internal: which Meta API sent an
        // outbound message; always null on an inbound row.
        send_route: _sendRoute,
        ...forwardableMessage
      } = inserted;
      await enqueueForwards(waba, 'message.received', {
        chat_id: chat.id,
        message_id: meta_message_id,
        message_type: msg.type,
        contact: { wa_id: phone, name },
        message: { ...forwardableMessage, interactive: interactiveReply },
      });
    }
  }
}

// Coexistence echo ingestion (smb_message_echoes) - Phase 1, echo ingestion
// only (see CLAUDE.md/the handover for this build). Per Meta's docs the
// array arrives under value.message_echoes (not value.messages), each entry
// shaped like an inbound message object but representing something the
// BUSINESS sent from their own phone (the WhatsApp Business app), which
// this app never originated. `to` is the customer's number - the chat this
// belongs to - `from` is the business's own number, unused here (the chat
// is already scoped by waba/client, not by which of the business's own
// numbers sent it).
//
// Mirrors handleInboundMessages' body-extraction shape so an echoed
// interactive/button reply (a business rep tapping a quick-reply on their
// own phone, in principle) still renders something readable, but an
// unrecognized/unstructured type is explicitly logged here - never silently
// dropped - since an echo predates any local record of what was sent, so
// there's no fallback source of truth for its content the way an outbound
// send we originated would have (its own body is already in the DB before
// Meta is ever called).
async function handleMessageEchoes(waba, value) {
  const clientId = waba.client_id;
  const echoes = value.message_echoes || value.smb_message_echoes || value.messages || [];
  for (const echo of echoes) {
    const phone = echo.to || echo.recipient_id;
    if (!phone) {
      console.warn('metaWebhook: smb_message_echoes entry with no `to`/`recipient_id` - cannot resolve a chat, skipping', { wabaId: waba.waba_id, echoId: echo.id });
      continue;
    }

    const buttonReply = echo.interactive?.button_reply;
    const listReply = echo.interactive?.list_reply;
    const templateButtonText = echo.button?.text;
    const recognized = echo.text?.body || buttonReply?.title || listReply?.title || templateButtonText;
    if (recognized === undefined) {
      console.warn('metaWebhook: smb_message_echoes entry with an unrecognized/unstructured type - storing best-effort, not dropping', {
        wabaId: waba.waba_id, echoId: echo.id, type: echo.type,
      });
    }
    const body = recognized || `[${echo.type || 'unknown'}]`;

    const contact = await contactsRepo.upsertByPhone(pool, clientId, { phone, name: phone, wa_id: phone });
    const chat = await chatsRepo.findOrCreateByContact(pool, clientId, contact);
    await chatsRepo.insertEcho(pool, clientId, chat.id, {
      metaMessageId: echo.id,
      body,
      sentAt: echo.timestamp ? new Date(Number(echo.timestamp) * 1000).toISOString() : null,
    });
  }
}

// Delivery lifecycle for messages we sent: sent -> delivered -> read, or failed.
// Takes the resolved waba row (not just clientId) - enqueueForwards below
// needs waba.forward_to_url/forward_events/id, same reasoning as
// handleInboundMessages/handleTemplateStatusUpdate/handleAccountUpdate above.
async function handleStatuses(waba, value) {
  for (const status of value.statuses || []) {
    const error = status.errors?.[0];
    await chatsRepo.updateStatusByMetaId(pool, waba.client_id, status.id, status.status, error?.title || null, error?.code || null);
    // Marketing Messages API: did Meta deliver it as marketing_lite, or fall
    // back to Cloud API (marketing-messages-api.md). Never breaks the handler.
    try {
      await chatsRepo.setSendRouteFromPricing(pool, waba.client_id, status.id, status.pricing?.category);
    } catch (err) {
      console.error('metaWebhook: send_route update failed:', err.message);
    }
    // Wasi's own billing messages (payment_notifications) - a no-op for any
    // message id that isn't one of ours. Never allowed to break the handler.
    try {
      await paymentNotificationsRepo.updateStatusByMetaId(status.id, status.status, error?.title || null);
    } catch (err) {
      console.error('metaWebhook: payment_notifications status update failed:', err.message);
    }

    // Meta redelivers on anything short of a fast 2xx - without this guard a
    // redelivered status produces a second identical forward to the CRM.
    // Keyed on (meta_message_id, status), not just meta_message_id, so a
    // real sent -> delivered -> read progression still forwards each
    // transition; only an exact repeat of the same pair is suppressed.
    // Atomic INSERT ... ON CONFLICT DO NOTHING, not check-then-act, so two
    // concurrent deliveries for the same status can't both win.
    const isNewForward = await messageStatusForwardsRepo.recordIfNew(pool, status.id, status.status);
    if (!isNewForward) continue;

    await enqueueForwards(waba, 'message.status', {
      message_id: status.id,
      status: status.status,
      error: status.status === 'failed' ? { code: error?.code || null, message: error?.title || null } : null,
    });
  }
}

// Each handler returns true/false for whether it actually did something -
// an explicit boolean, not a truthy/falsy value inferred from a DB call's
// return (pool.query() resolves to a result object either way, which would
// make "did this handle the event" impossible to tell from the return value
// alone). Takes the resolved waba row, not just its Meta waba_id - same
// reasoning as handleInboundMessages above.
async function handleTemplateStatusUpdate(waba, value) {
  if (!value?.message_template_name) return false;
  // value.reason is only present on a rejection; on any other transition
  // (e.g. a later approval of a since-corrected template) this correctly
  // clears a stale rejection_reason from a previous cycle.
  const status = String(value.event || '').toLowerCase() || 'pending';
  const reason = value.reason || null;
  // Matched to name alone (no language/id) until 2026-11-11: Meta scopes a
  // template to (name, language) per WABA (messageTemplatesRepo.js's own
  // findActiveByNameAndLanguage comment), so a client with the same name in
  // two languages had a status change to ONE language variant overwrite
  // every row sharing that name, client-wide - a real bug, not a timing
  // issue, found while investigating a client's template showing "approved"
  // locally while still pending/rejected on Meta. message_template_id (this
  // payload's id for the exact template version) is Meta's documented field
  // name and the most precise match available - prefer it when present.
  // message_template_language is Meta's documented field for this event too,
  // confirmed against Meta's Cloud API webhook reference, and is the next
  // best match. Only fall back to name-alone (the old, unsafe behavior) if
  // neither is present, and log it so a real occurrence is visible.
  let result;
  if (value.message_template_id) {
    result = await pool.query(
      `update message_templates set status = $1, rejection_reason = $2, updated_at = now()
       where meta_template_id = $3 and client_id = $4`,
      [status, reason, String(value.message_template_id), waba.client_id]
    );
  }
  if (!result || result.rowCount === 0) {
    if (value.message_template_language) {
      result = await pool.query(
        `update message_templates set status = $1, rejection_reason = $2, updated_at = now()
         where name = $3 and language = $4 and client_id = $5`,
        [status, reason, value.message_template_name, value.message_template_language, waba.client_id]
      );
    }
  }
  if (!result || result.rowCount === 0) {
    console.error(
      'metaWebhook: message_template_status_update had no message_template_id/message_template_language match, falling back to name-only (unsafe for multi-language templates):',
      value.message_template_name,
    );
    await pool.query(
      `update message_templates set status = $1, rejection_reason = $2, updated_at = now()
       where name = $3 and client_id = $4`,
      [status, reason, value.message_template_name, waba.client_id]
    );
  }
  // A consuming app needs to know when its own template is paused/rejected
  // - it can't poll Meta itself, it only ever talks to Wasi.
  await enqueueForwards(waba, 'message_template_status_update', value);
  return true;
}

// template_category_update (Meta's webhook reference, confirmed against the
// docs 2026-11-24, not yet against a live delivery): two variants.
//   Advance notice: { correct_category, new_category (= current),
//     category_update_timestamp } - the change Meta will make in ~24h.
//   Completed: { previous_category, new_category }.
// Matched by message_template_id, then (name, language) - Meta sends
// language as "en-US", stored as "en_US". Not forwarded to consuming apps:
// wabas.forward_events' CHECK has no such event yet.
async function handleTemplateCategoryUpdate(waba, value) {
  if (!value?.message_template_name && !value?.message_template_id) return false;
  let template = null;
  if (value.message_template_id) {
    ({ rows: [template] } = await pool.query(
      'select id from message_templates where client_id = $1 and meta_template_id = $2',
      [waba.client_id, String(value.message_template_id)]
    ));
  }
  if (!template && value.message_template_name) {
    const language = String(value.message_template_language || '').replace('-', '_');
    ({ rows: [template] } = await pool.query(
      `select id from message_templates where client_id = $1 and name = $2 and ($3 = '' or language = $3)
       order by created_at desc limit 1`,
      [waba.client_id, value.message_template_name, language]
    ));
  }
  await auditLogRepo.record({
    actor_type: 'meta_webhook',
    actor_id: null,
    action: 'template_category_update',
    target: `${waba.client_id}: ${JSON.stringify(value).slice(0, 500)}`,
  });
  if (!template) {
    console.error('metaWebhook: template_category_update for an unknown template:', value.message_template_name, value.message_template_id);
    return true;
  }
  if (value.correct_category) {
    const effectiveAt = Number(value.category_update_timestamp)
      ? new Date(Number(value.category_update_timestamp) * 1000)
      : new Date(Date.now() + 24 * 60 * 60 * 1000);
    await messageTemplatesRepo.setUpcomingCategory(pool, template.id, mapMetaCategory(value.correct_category), effectiveAt);
  } else if (value.new_category) {
    await messageTemplatesRepo.applyMetaCategory(
      pool, template.id, mapMetaCategory(value.new_category),
      value.previous_category ? mapMetaCategory(value.previous_category) : null
    );
  }
  return true;
}

async function handleAccountUpdate(waba, value) {
  // A business accepted the Marketing Messages API terms (Meta's documented
  // event; payload carries waba_info, no phone_number). Admin "Check now"
  // reads the full status from Meta.
  if (value?.event === 'MM_LITE_TERMS_SIGNED') {
    await pool.query('update wabas set mm_api_status = $1, mm_api_checked_at = now() where id = $2', ['MM_LITE_TERMS_SIGNED', waba.id]);
    await auditLogRepo.record({ actor_type: 'meta_webhook', actor_id: null, action: 'mm_api_terms_signed', target: `${waba.client_id}: waba ${waba.waba_id}` });
    return true;
  }
  if (!value?.phone_number) return false;
  // restriction_info/ban_info are Meta's documented field names for this
  // payload, but - like the phone_number_quality_update etc. fields below -
  // haven't been confirmed against a live example the way messages/statuses
  // have. Captured defensively (present -> stored as-is, absent -> cleared)
  // rather than guessed at more granularly; the full raw payload also
  // always goes to the audit log so nothing is lost if the real shape turns
  // out to differ once a live restriction event is actually seen.
  const restriction = value.restriction_info?.length
    ? JSON.stringify(value.restriction_info)
    : value.ban_info
      ? JSON.stringify(value.ban_info)
      : null;
  // messaging_limit_tier: unlike restriction_info/ban_info above, this field
  // name IS documented in Meta's public Cloud API reference (see
  // metaClient.js's getPhoneNumberDetails comment) - but whether Meta
  // actually includes it in a real account_update payload (vs. only on a
  // direct phone-number GET) has never been confirmed live, so it's read
  // defensively (present -> stored, absent -> left alone) same as every
  // other unconfirmed field in this handler; the raw value is already
  // captured to audit log unconditionally below regardless.
  const tier = typeof value.messaging_limit_tier === 'string' && value.messaging_limit_tier ? value.messaging_limit_tier : null;
  await pool.query(
    `update wabas set quality_rating = coalesce($1, quality_rating), restriction_status = $2,
     messaging_tier = coalesce($3, messaging_tier),
     messaging_tier_checked_at = case when $3 is not null then now() else messaging_tier_checked_at end
     where id = $4`,
    [value.quality_rating || null, restriction, tier, waba.id]
  );
  await auditLogRepo.record({
    actor_type: 'meta_webhook',
    actor_id: null,
    action: 'account_update',
    target: `${waba.waba_id}: ${JSON.stringify(value).slice(0, 500)}`,
  });
  // A consuming app needs to know when its own WABA is restricted - same
  // reasoning as the template-status forward above.
  await enqueueForwards(waba, 'account_update', value);
  return true;
}

// message_template_quality_update, phone_number_quality_update, and
// phone_number_name_update are recognized field names (so they don't fall
// into the "unhandled" warning below), but their real payload shapes haven't
// been verified against a live example the way messages/statuses now have -
// see the raw capture in server/test/metaWebhookDispatch.test.js for what
// *is* verified. Rather than guess a DB update against an unconfirmed shape,
// this records the full payload to the audit log so nothing is silently
// lost; upgrade to a real column update once a live payload confirms the shape.
async function handleUnmappedWabaEvent(field, entryId, value) {
  await auditLogRepo.record({
    actor_type: 'meta_webhook',
    actor_id: null,
    action: `${field}_unmapped`,
    target: `${entryId}: ${JSON.stringify(value).slice(0, 500)}`,
  });
  return true;
}

// Fields Meta sends under a distinct field name (unlike messages/statuses,
// which both arrive under field: "messages" - see below) - field-based
// dispatch is correct for these.
const WABA_SCOPED_FIELD_HANDLERS = {
  message_template_status_update: handleTemplateStatusUpdate,
  template_category_update: handleTemplateCategoryUpdate,
  account_update: handleAccountUpdate,
  message_template_quality_update: (waba, value) => handleUnmappedWabaEvent('message_template_quality_update', waba.waba_id, value),
  phone_number_quality_update: (waba, value) => handleUnmappedWabaEvent('phone_number_quality_update', waba.waba_id, value),
  phone_number_name_update: (waba, value) => handleUnmappedWabaEvent('phone_number_name_update', waba.waba_id, value),
};

router.post('/', asyncHandler(async (req, res) => {
  // Server-side timing (hrtime, not wall-clock through any tunnel/proxy) -
  // Meta expects a 2xx within ~3s and treats slower as a failed delivery
  // (triggering retries), so this is a real operational budget to watch,
  // not just diagnostics. Logged unconditionally since this handler is low
  // enough volume that always-on timing is cheap and worth having for the
  // life of the app, not just this verification pass.
  const startedAt = process.hrtime.bigint();

  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'))) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const entries = req.body?.entry || [];
  const fieldsSeen = [];
  // Genuine processing failure (a change we recognized and attempted, whose
  // handler threw), not "we don't have a handler for this field" - those
  // are counted separately (see the `handled` warning below) and never
  // cause a non-200 response, since retrying a field we'll never process
  // just wastes Meta's retry budget for no benefit.
  let anyChangeFailed = false;
  // Feeds meta_webhook_log below - Phase 6's "last successful webhook
  // received per WABA" health check and the alerting engine's "sustained
  // non-200" check both read this table, not application logs.
  const wabaIdsTouched = new Set();
  const failedFields = [];

  for (const entry of entries) {
    let waba = null;
    try {
      waba = await wabasRepo.findByWabaId(entry.id);
      if (waba) wabaIdsTouched.add(waba.id);
    } catch (err) {
      console.error('metaWebhook: failed to resolve waba for entry', entry.id, err.message);
    }

    for (const change of entry.changes || []) {
      const { field, value } = change;
      fieldsSeen.push(field);
      let handled = false;

      try {
        // Meta sends BOTH new inbound messages and delivery status updates
        // under field: "messages" - field name alone can't distinguish them
        // (confirmed against a live payload: a status-only delivery still
        // arrives with field: "messages", not field: "statuses"). Content
        // decides what runs, and a single change can legitimately carry
        // both arrays at once, so these are independent checks, not
        // if/else - process whichever is actually present.
        //
        // Never for an echo field: the echo handler below tolerates an echo
        // whose array sits under `messages` (the payload shape is not
        // confirmed against a live capture - as of 2026-10-03 production had never
        // received a smb_message_echoes change, see docs/ai-agent/SPEC.md
        // decision 14), and without this guard
        // that same array also satisfied this branch, ingesting the
        // BUSINESS'S OWN outgoing message as an inbound customer message
        // (a contact for the business's own number, flow engine and keyword
        // automation fired on it). Guarded by field name, deliberately and
        // only that: the shape is not widened or narrowed here.
        // server/test/metaWebhookEchoRouting.test.js covers it through the
        // real router.
        if (waba && field !== 'smb_message_echoes' && Array.isArray(value?.messages) && value.messages.length > 0) {
          await handleInboundMessages(waba, value);
          handled = true;
        }
        if (waba && Array.isArray(value?.statuses) && value.statuses.length > 0) {
          await handleStatuses(waba, value);
          handled = true;
        }
        // Coexistence echo ingestion - checked by value shape (same pattern
        // as messages/statuses above: "field name alone can't distinguish
        // them"), not registered in WABA_SCOPED_FIELD_HANDLERS below on
        // purpose - a field-keyed entry there would double-process this
        // same array whenever it's actually present, since this check
        // already runs first. `field` is still recorded into `fieldsSeen`
        // (below) regardless, so a real smb_message_echoes delivery whose
        // array turns out to be shaped differently than Meta's docs say -
        // this codebase has been burned before by trusting an unconfirmed
        // Meta payload shape, see handleUnmappedWabaEvent's own history -
        // still surfaces loudly via the "unhandled payload" warning instead
        // of silently vanishing.
        const echoList = value?.message_echoes || value?.smb_message_echoes || (field === 'smb_message_echoes' ? value?.messages : null);
        if (waba && Array.isArray(echoList) && echoList.length > 0) {
          await handleMessageEchoes(waba, value);
          handled = true;
        }

        // These fields, unlike messages/statuses, genuinely are distinct by
        // name - field-based dispatch is correct here. Guarded on `waba`
        // like the two branches above (previously handleTemplateStatusUpdate
        // ran even with waba === null, re-resolving client_id itself via a
        // subquery that was a no-op when the waba didn't exist anyway - same
        // real-world result, this is just explicit about it now that these
        // handlers need the full waba row for hub forwarding).
        const wabaScopedHandler = WABA_SCOPED_FIELD_HANDLERS[field];
        if (waba && wabaScopedHandler && (await wabaScopedHandler(waba, value))) {
          handled = true;
        }

        if (!handled) {
          console.warn(
            `metaWebhook: unhandled payload - field="${field}", entry=${entry.id}, ` +
            `value keys=[${Object.keys(value || {}).join(', ')}]`
          );
        }
      } catch (err) {
        // Deliberately DOES 500 the whole delivery, so Meta retries the
        // entire payload - the asymmetry matters: inbound message inserts
        // are idempotent on meta_message_id, so reprocessing an
        // already-succeeded change alongside the retry costs nothing, but
        // a write that fails and gets acknowledged with 200 is gone
        // forever once Meta's 7-day retry window lapses. This is the same
        // failure shape (failed write, swallowed error, 200 returned) that
        // caused the Sirah CRM incident referenced in wasi-build-plan.md.
        anyChangeFailed = true;
        failedFields.push(`${field}: ${err.message}`);
        // Loud and structured on purpose - grep-able as "metaWebhook FAILURE"
        // distinctly from the "unhandled payload" warning below, so this is
        // alertable later (see Phase 6 §6.1) rather than scrolling past in
        // a log nobody's watching.
        console.error('metaWebhook FAILURE:', {
          field,
          entryId: entry.id,
          error: err.message,
          stack: err.stack,
        });
      }

      await auditLogRepo.record({
        actor_type: 'meta_webhook',
        actor_id: null,
        action: field || 'unknown_event',
        target: entry.id || null,
      });
    }
  }

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const budgetFlag = durationMs > 2000 ? ' NEAR/OVER META\'S ~3s BUDGET' : '';
  console.log(
    `metaWebhook: processed [${fieldsSeen.join(', ') || 'no changes'}] in ${durationMs.toFixed(1)}ms${budgetFlag}` +
    (anyChangeFailed ? ' - FAILED, returning 500 for Meta to retry' : '')
  );

  // Persisted, not just logged - see migration 018's module comment. A
  // failure here would be ironic (an unmonitorable monitoring write) but
  // shouldn't fail the whole delivery, so it's caught and logged, not awaited
  // into the main failure path.
  try {
    await pool.query(
      `insert into meta_webhook_log (success, duration_ms, entries_processed, waba_ids_touched, error_summary)
       values ($1, $2, $3, $4, $5)`,
      [
        !anyChangeFailed,
        durationMs,
        entries.length,
        Array.from(wabaIdsTouched),
        failedFields.length > 0 ? failedFields.join('; ').slice(0, 1000) : null,
      ]
    );
  } catch (err) {
    console.error('metaWebhook: failed to persist meta_webhook_log row (non-fatal):', err.message);
  }

  res.sendStatus(anyChangeFailed ? 500 : 200);
}));

module.exports = router;
// Exposed for stub-only unit tests (server/test/coexistenceEchoIngestion.test.js)
// - everything else in this file is only reachable through a full HTTP
// request with a valid Meta signature, which this specific handler's own
// logic (ingestion shape/idempotency/contact-and-chat resolution) doesn't
// need to exercise.
module.exports.handleMessageEchoes = handleMessageEchoes;
