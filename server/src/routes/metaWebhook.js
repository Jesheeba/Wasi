const { Router } = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const auditLogRepo = require('../repositories/auditLogRepo');
const wabasRepo = require('../repositories/wabasRepo');
const contactsRepo = require('../repositories/contactsRepo');
const chatsRepo = require('../repositories/chatsRepo');
const consentRepo = require('../repositories/consentRepo');
const usageRepo = require('../repositories/usageRepo');
const clientWebhooksRepo = require('../repositories/clientWebhooksRepo');
const webhookDeliveriesRepo = require('../repositories/webhookDeliveriesRepo');
const messageStatusForwardsRepo = require('../repositories/messageStatusForwardsRepo');
const flowEngine = require('../services/flowEngine');
const { isOptOutMessage } = require('../utils/optOutKeywords');
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
// keyed by the app secret — verifying this is what proves a payload actually
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
// durable, retried queue (build plan Phase 5) — wabas.forward_to_url (a
// hub-connected consuming app) and client_webhooks.callback_url (the
// client's own generic integration webhook, Settings > Webhook) are
// independent, optional targets, and a client can have either, both, or
// neither configured. This replaces what used to be two separate
// mechanisms: this enqueue for the hub target, and a fire-and-forget fetch
// with no retry for the client's own webhook.
//
// Event selection is explicit per target (migration
// 015_explicit_forward_events.js), not implicit — each target declares
// its own `events` array at configuration time (routes/clientWebhook.js,
// routes/admin.js's hub-forward config) and only receives events it's
// actually listed. This was a real gap in the initial unification: it
// widened client_webhooks from message.received-only to silently
// receiving all three event types with no way to opt out, which would
// have been a breaking contract change for an existing subscriber (none
// existed yet, confirmed live before this fix — but the next one would
// have hit it). Signed identically for both targets
// (x-wasi-signature-256, HMAC-SHA256 of the JSON body), so nothing about
// how a receiving app verifies a delivery changes based on which target
// or which events it's configured for.
async function enqueueForwards(waba, event, payload) {
  // waba_id/enqueued_at added here, once, so every event type (message.received,
  // message.status, message_template_status_update, account_update) and every
  // target (hub forward_to_url, client_webhooks) gets them uniformly without
  // each handler assembling its own envelope fields. enqueued_at is when this
  // event was received/enqueued, not when a delivery attempt fires — stable
  // across forwardRunner.js's retries, not re-stamped per attempt. Named
  // enqueued_at rather than timestamp so it can't be confused with
  // message.received's own message.sent_at in the same payload.
  const envelopeData = { ...payload, waba_id: waba.waba_id, enqueued_at: new Date().toISOString() };

  if (waba.forward_to_url && waba.forward_events?.includes(event)) {
    await webhookDeliveriesRepo.enqueue(pool, {
      clientId: waba.client_id,
      wabaId: waba.id,
      event,
      payload: envelopeData,
      targetUrl: waba.forward_to_url,
      targetSecret: waba.forward_secret,
    });
  }

  let clientWebhook;
  try {
    clientWebhook = await clientWebhooksRepo.findByClientId(pool, waba.client_id);
  } catch (err) {
    console.error('metaWebhook: failed to look up client_webhooks for', waba.client_id, err.message);
    clientWebhook = null;
  }
  if (clientWebhook && clientWebhook.events?.includes(event)) {
    await webhookDeliveriesRepo.enqueue(pool, {
      clientId: waba.client_id,
      wabaId: waba.id,
      event,
      payload: envelopeData,
      targetUrl: clientWebhook.callback_url,
      targetSecret: clientWebhook.secret,
    });
  }
}

// New customer message: upsert the contact, find/open their chat, insert
// (idempotent on Meta's message id), then let automation rules react.
// Takes the resolved waba row (not just clientId) — build plan Phase 5's
// hub forwarding needs waba.forward_to_url/forward_secret/id, which the
// caller already has from wabasRepo.findByWabaId and shouldn't re-fetch.
async function handleInboundMessages(waba, value) {
  const clientId = waba.client_id;
  const contactInfo = value.contacts?.[0];
  for (const msg of value.messages || []) {
    const phone = msg.from;
    const name = contactInfo?.profile?.name || phone;
    // Free-form interactive button replies (see metaClient.sendInteractiveMessage)
    // come back as msg.interactive.button_reply.{id,title} — title is what a
    // human reads in the chat; id is the stable value the flow engine
    // branches on (routes/flowEngine.js), never re-derived from title here.
    const buttonReply = msg.interactive?.button_reply;
    // A tap on a list-message row — msg.interactive.list_reply.{id,title,
    // description}, Meta's other interactive reply shape alongside
    // button_reply above. Never received live yet (no metaClient function
    // builds a list message to send in the first place — see
    // metaClient.sendListMessage), so this is doc-shape, not
    // capture-verified the way button_reply now is; still routed the same
    // way rather than left as the old "[interactive]" fallback that
    // silently discarded id/title/description entirely.
    const listReply = msg.interactive?.list_reply;
    // Template quick-reply clicks (type: "button") are a separate shape —
    // msg.button.{text,payload} — from the flow-builder's own interactive
    // buttons above. Reading .text here is what lets an automation rule's
    // trigger keyword match the button's label (e.g. "Received").
    const templateButtonText = msg.button?.text;
    const body = msg.text?.body || buttonReply?.title || listReply?.title || templateButtonText || `[${msg.type}]`; // MVP: other non-text types still render as a type tag

    // Forwarded verbatim alongside `body` in message.received (see below) —
    // body alone only ever carried the reply's title (e.g. "Yes"), never
    // its id (e.g. "flow_test_yes") or, for a list row, its description —
    // the stable values a receiving CRM needs to route on programmatically
    // rather than parsing display text. null for a non-interactive message,
    // kept as an explicit field (not omitted) so a receiving CRM can always
    // check it rather than guess whether an absent key means "not
    // interactive" or "never sent."
    const interactiveReply = buttonReply
      ? { type: 'button_reply', id: buttonReply.id, title: buttonReply.title }
      : listReply
        ? { type: 'list_reply', id: listReply.id, title: listReply.title, description: listReply.description ?? null }
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
    const inserted = await chatsRepo.insertInbound(pool, clientId, chat.id, {
      metaMessageId: msg.id,
      body,
      sentAt: msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : null,
    });

    if (inserted) {
      await usageRepo.incrementReceived(pool, clientId);

      // Opt-out (build plan Phase 4) — recorded before automation runs, so
      // the consent_events row exists regardless of whatever a client's own
      // automation rules do with this same inbound message.
      //
      // Isolated for the same reason flowEngine.evaluate() below is: the
      // insert above is idempotent on meta_message_id, so an uncaught throw
      // here would 500 (Meta retries) but the retry's insert becomes a
      // no-op, permanently skipping this whole block — including
      // enqueueForwards — with no way to ever recover it. That's not a
      // trade worth making for a consent write specifically: recordEvent is
      // its own atomic transaction (see consentRepo.js), so a throw already
      // means nothing was persisted regardless of whether we retry: the
      // real enforcement point (messagingService.assertConsentForTemplate)
      // re-checks contacts.opt_in_status fresh from the DB at send time
      // rather than trusting this request succeeded. Swallowing here loses
      // no protection the old code actually had — it just stops a lost
      // consent write from also killing the forward.
      if (isOptOutMessage(body)) {
        try {
          await consentRepo.recordEvent(clientId, contact.id, {
            event: 'opted_out',
            source: 'inbound_stop_keyword',
            evidence: { message_id: inserted.id, meta_message_id: msg.id, body },
          });
        } catch (err) {
          console.error('metaWebhook: consentRepo.recordEvent FAILED for an opt-out message — opt-out was NOT recorded, needs manual follow-up:', {
            clientId, metaMessageId: msg.id, error: err.message,
          });
        }
      }

      // Isolated so a bug in a client's own automation rules can never
      // silently kill forwarding for this message: same idempotent-insert
      // trap as the opt-out block above — an uncaught throw here would 500
      // and make Meta retry, but the retry's insert is a no-op, so
      // enqueueForwards below would never run again for this message. A
      // receiving CRM silently losing an inbound message is worse than one
      // client's automation rule silently not firing once, so this
      // deliberately does NOT re-throw — do not "simplify" this away.
      try {
        await flowEngine.evaluate(pool, clientId, contact, chat, msg, body);
      } catch (err) {
        console.error('metaWebhook: flowEngine.evaluate FAILED — forwarding continues regardless:', {
          clientId, metaMessageId: msg.id, error: err.message,
        });
      }

      // This only enqueues; forwardRunner.js does the actual delivery
      // attempt(s), on its own schedule, outside this request entirely —
      // see its module comment for why that separation is load-bearing,
      // not just tidy.
      //
      // message_id is promoted out of `inserted` to match message.status
      // forwards' top-level field of the same name (fix #2) — meta_message_id
      // is the real WhatsApp id, id/client_id are Wasi-internal PKs a
      // receiving CRM has no use for and shouldn't see. status is dropped
      // entirely (not renamed) — chatsRepo.insertInbound hardcodes it to
      // 'delivered' for every inbound row (it's a DB-write confirmation, not
      // a real WhatsApp delivery status), so forwarding it would mislead a
      // CRM into reading it as one. message.status forwards (handleStatuses)
      // carry Meta's real, meaningful status and are untouched by this.
      // direction is dropped too — always 'in' on this event type (only
      // inbound messages reach this handler), so it's pure redundancy with
      // the event name itself. error_reason/meta_error_code are dropped —
      // both columns are shared with outbound-send-failure rows in this same
      // messages table and are always null on an inbound row; forwarding
      // them here would just be two guaranteed-null fields.
      const {
        id, client_id, chat_id: _chatId, meta_message_id, status: _hardcodedStatus,
        direction: _direction, error_reason: _errorReason, meta_error_code: _metaErrorCode,
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

// Delivery lifecycle for messages we sent: sent -> delivered -> read, or failed.
// Takes the resolved waba row (not just clientId) — enqueueForwards below
// needs waba.forward_to_url/forward_events/id, same reasoning as
// handleInboundMessages/handleTemplateStatusUpdate/handleAccountUpdate above.
async function handleStatuses(waba, value) {
  for (const status of value.statuses || []) {
    const error = status.errors?.[0];
    await chatsRepo.updateStatusByMetaId(pool, waba.client_id, status.id, status.status, error?.title || null, error?.code || null);

    // Meta redelivers on anything short of a fast 2xx — without this guard a
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

// Each handler returns true/false for whether it actually did something —
// an explicit boolean, not a truthy/falsy value inferred from a DB call's
// return (pool.query() resolves to a result object either way, which would
// make "did this handle the event" impossible to tell from the return value
// alone). Takes the resolved waba row, not just its Meta waba_id — same
// reasoning as handleInboundMessages above.
async function handleTemplateStatusUpdate(waba, value) {
  if (!value?.message_template_name) return false;
  // value.reason is only present on a rejection; on any other transition
  // (e.g. a later approval of a since-corrected template) this correctly
  // clears a stale rejection_reason from a previous cycle.
  await pool.query(
    `update message_templates set status = $1, rejection_reason = $2, updated_at = now()
     where name = $3 and client_id = $4`,
    [String(value.event || '').toLowerCase() || 'pending', value.reason || null, value.message_template_name, waba.client_id]
  );
  // A consuming app needs to know when its own template is paused/rejected
  // — it can't poll Meta itself, it only ever talks to Wasi.
  await enqueueForwards(waba, 'message_template_status_update', value);
  return true;
}

async function handleAccountUpdate(waba, value) {
  if (!value?.phone_number) return false;
  // restriction_info/ban_info are Meta's documented field names for this
  // payload, but — like the phone_number_quality_update etc. fields below —
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
  await pool.query(
    `update wabas set quality_rating = coalesce($1, quality_rating), restriction_status = $2 where id = $3`,
    [value.quality_rating || null, restriction, waba.id]
  );
  await auditLogRepo.record({
    actor_type: 'meta_webhook',
    actor_id: null,
    action: 'account_update',
    target: `${waba.waba_id}: ${JSON.stringify(value).slice(0, 500)}`,
  });
  // A consuming app needs to know when its own WABA is restricted — same
  // reasoning as the template-status forward above.
  await enqueueForwards(waba, 'account_update', value);
  return true;
}

// message_template_quality_update, phone_number_quality_update, and
// phone_number_name_update are recognized field names (so they don't fall
// into the "unhandled" warning below), but their real payload shapes haven't
// been verified against a live example the way messages/statuses now have —
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
// which both arrive under field: "messages" — see below) — field-based
// dispatch is correct for these.
const WABA_SCOPED_FIELD_HANDLERS = {
  message_template_status_update: handleTemplateStatusUpdate,
  account_update: handleAccountUpdate,
  message_template_quality_update: (waba, value) => handleUnmappedWabaEvent('message_template_quality_update', waba.waba_id, value),
  phone_number_quality_update: (waba, value) => handleUnmappedWabaEvent('phone_number_quality_update', waba.waba_id, value),
  phone_number_name_update: (waba, value) => handleUnmappedWabaEvent('phone_number_name_update', waba.waba_id, value),
};

router.post('/', asyncHandler(async (req, res) => {
  // Server-side timing (hrtime, not wall-clock through any tunnel/proxy) —
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
  // handler threw), not "we don't have a handler for this field" — those
  // are counted separately (see the `handled` warning below) and never
  // cause a non-200 response, since retrying a field we'll never process
  // just wastes Meta's retry budget for no benefit.
  let anyChangeFailed = false;
  // Feeds meta_webhook_log below — Phase 6's "last successful webhook
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
        // under field: "messages" — field name alone can't distinguish them
        // (confirmed against a live payload: a status-only delivery still
        // arrives with field: "messages", not field: "statuses"). Content
        // decides what runs, and a single change can legitimately carry
        // both arrays at once, so these are independent checks, not
        // if/else — process whichever is actually present.
        if (waba && Array.isArray(value?.messages) && value.messages.length > 0) {
          await handleInboundMessages(waba, value);
          handled = true;
        }
        if (waba && Array.isArray(value?.statuses) && value.statuses.length > 0) {
          await handleStatuses(waba, value);
          handled = true;
        }

        // These fields, unlike messages/statuses, genuinely are distinct by
        // name — field-based dispatch is correct here. Guarded on `waba`
        // like the two branches above (previously handleTemplateStatusUpdate
        // ran even with waba === null, re-resolving client_id itself via a
        // subquery that was a no-op when the waba didn't exist anyway — same
        // real-world result, this is just explicit about it now that these
        // handlers need the full waba row for hub forwarding).
        const wabaScopedHandler = WABA_SCOPED_FIELD_HANDLERS[field];
        if (waba && wabaScopedHandler && (await wabaScopedHandler(waba, value))) {
          handled = true;
        }

        if (!handled) {
          console.warn(
            `metaWebhook: unhandled payload — field="${field}", entry=${entry.id}, ` +
            `value keys=[${Object.keys(value || {}).join(', ')}]`
          );
        }
      } catch (err) {
        // Deliberately DOES 500 the whole delivery, so Meta retries the
        // entire payload — the asymmetry matters: inbound message inserts
        // are idempotent on meta_message_id, so reprocessing an
        // already-succeeded change alongside the retry costs nothing, but
        // a write that fails and gets acknowledged with 200 is gone
        // forever once Meta's 7-day retry window lapses. This is the same
        // failure shape (failed write, swallowed error, 200 returned) that
        // caused the Sirah CRM incident referenced in wasi-build-plan.md.
        anyChangeFailed = true;
        failedFields.push(`${field}: ${err.message}`);
        // Loud and structured on purpose — grep-able as "metaWebhook FAILURE"
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
    (anyChangeFailed ? ' — FAILED, returning 500 for Meta to retry' : '')
  );

  // Persisted, not just logged — see migration 018's module comment. A
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
