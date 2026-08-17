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
    webhook = await clientWebhooksRepo.findByClientId(clientId);
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

    const contact = await contactsRepo.upsertByPhone(clientId, { phone, name, wa_id: phone });
    const chat = await chatsRepo.findOrCreateByContact(clientId, contact);
    const inserted = await chatsRepo.insertInbound(clientId, chat.id, {
      metaMessageId: msg.id,
      body,
      sentAt: msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : null,
    });

    if (inserted) {
      await usageRepo.incrementReceived(clientId);

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

      await automationEngine.evaluate(clientId, chat, body);
      await forwardToClientWebhook(clientId, 'message.received', { chat_id: chat.id, message: inserted });
    }
  }
}

// Delivery lifecycle for messages we sent: sent -> delivered -> read, or failed.
async function handleStatuses(clientId, value) {
  for (const status of value.statuses || []) {
    const errorReason = status.errors?.[0]?.title || null;
    await chatsRepo.updateStatusByMetaId(clientId, status.id, status.status, errorReason);
  }
}

router.post('/', asyncHandler(async (req, res) => {
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'))) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const entries = req.body?.entry || [];

  for (const entry of entries) {
    let waba = null;
    try {
      waba = await wabasRepo.findByWabaId(entry.id);
    } catch (err) {
      console.error('metaWebhook: failed to resolve waba for entry', entry.id, err.message);
    }

    for (const change of entry.changes || []) {
      const { field, value } = change;

      try {
        if (field === 'messages' && waba) {
          await handleInboundMessages(waba.client_id, value);
        } else if (field === 'statuses' && waba) {
          await handleStatuses(waba.client_id, value);
        } else if (field === 'message_template_status_update' && value?.message_template_name) {
          await pool.query(
            `update message_templates set status = $1, updated_at = now()
             where name = $2 and client_id in (select client_id from wabas where waba_id = $3)`,
            [String(value.event || '').toLowerCase() || 'pending', value.message_template_name, entry.id]
          );
        } else if (field === 'account_update' && value?.phone_number) {
          await pool.query(
            `update wabas set quality_rating = coalesce($1, quality_rating) where waba_id = $2`,
            [value.quality_rating || null, entry.id]
          );
        }
      } catch (err) {
        // One bad change in a batch shouldn't 500 the whole delivery and
        // cause Meta to retry the entire (possibly large) payload.
        console.error(`metaWebhook: failed to process field "${field}" for entry ${entry.id}:`, err.message);
      }

      await auditLogRepo.record({
        actor_type: 'meta_webhook',
        actor_id: null,
        action: field || 'unknown_event',
        target: entry.id || null,
      });
    }
  }

  res.sendStatus(200);
}));

module.exports = router;
