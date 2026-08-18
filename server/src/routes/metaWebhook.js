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
const automationEngine = require('../services/automationEngine');
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

// Forwards to the client's own configured endpoint (Settings > Webhook), if
// any — best-effort, fire-and-forget: a slow or broken client endpoint must
// never block or fail WhatsApp message ingestion. Signed the same way Meta
// signs its calls to us, so the client can verify authenticity.
async function forwardToClientWebhook(clientId, event, payload) {
  let webhook;
  try {
    webhook = await clientWebhooksRepo.findByClientId(pool, clientId);
  } catch (_err) {
    return;
  }
  if (!webhook) return;

  const body = JSON.stringify({ event, data: payload });
  const signature = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
  fetch(webhook.callback_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-wasi-signature-256': `sha256=${signature}` },
    body,
  }).catch((err) => console.error(`client webhook forward failed for ${clientId}:`, err.message));
}

// New customer message: upsert the contact, find/open their chat, insert
// (idempotent on Meta's message id), then let automation rules react.
async function handleInboundMessages(clientId, value) {
  const contactInfo = value.contacts?.[0];
  for (const msg of value.messages || []) {
    const phone = msg.from;
    const name = contactInfo?.profile?.name || phone;
    const body = msg.text?.body || `[${msg.type}]`; // MVP: non-text types render as a type tag, not fetched/decoded

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
      if (isOptOutMessage(body)) {
        await consentRepo.recordEvent(clientId, contact.id, {
          event: 'opted_out',
          source: 'inbound_stop_keyword',
          evidence: { message_id: inserted.id, meta_message_id: msg.id, body },
        });
      }

      await automationEngine.evaluate(pool, clientId, chat, body);
      await forwardToClientWebhook(clientId, 'message.received', { chat_id: chat.id, message: inserted });
    }
  }
}

// Delivery lifecycle for messages we sent: sent -> delivered -> read, or failed.
async function handleStatuses(clientId, value) {
  for (const status of value.statuses || []) {
    const errorReason = status.errors?.[0]?.title || null;
    await chatsRepo.updateStatusByMetaId(pool, clientId, status.id, status.status, errorReason);
  }
}

// Each handler returns true/false for whether it actually did something —
// an explicit boolean, not a truthy/falsy value inferred from a DB call's
// return (pool.query() resolves to a result object either way, which would
// make "did this handle the event" impossible to tell from the return value
// alone).
async function handleTemplateStatusUpdate(entryId, value) {
  if (!value?.message_template_name) return false;
  await pool.query(
    `update message_templates set status = $1, updated_at = now()
     where name = $2 and client_id in (select client_id from wabas where waba_id = $3)`,
    [String(value.event || '').toLowerCase() || 'pending', value.message_template_name, entryId]
  );
  return true;
}

async function handleAccountUpdate(entryId, value) {
  if (!value?.phone_number) return false;
  await pool.query(
    `update wabas set quality_rating = coalesce($1, quality_rating) where waba_id = $2`,
    [value.quality_rating || null, entryId]
  );
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
  message_template_quality_update: (entryId, value) => handleUnmappedWabaEvent('message_template_quality_update', entryId, value),
  phone_number_quality_update: (entryId, value) => handleUnmappedWabaEvent('phone_number_quality_update', entryId, value),
  phone_number_name_update: (entryId, value) => handleUnmappedWabaEvent('phone_number_name_update', entryId, value),
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

  for (const entry of entries) {
    let waba = null;
    try {
      waba = await wabasRepo.findByWabaId(entry.id);
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
          await handleInboundMessages(waba.client_id, value);
          handled = true;
        }
        if (waba && Array.isArray(value?.statuses) && value.statuses.length > 0) {
          await handleStatuses(waba.client_id, value);
          handled = true;
        }

        // These fields, unlike messages/statuses, genuinely are distinct by
        // name — field-based dispatch is correct here.
        const wabaScopedHandler = WABA_SCOPED_FIELD_HANDLERS[field];
        if (wabaScopedHandler && (await wabaScopedHandler(entry.id, value))) {
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

  res.sendStatus(anyChangeFailed ? 500 : 200);
}));

module.exports = router;
