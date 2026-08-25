// Background campaign fan-out — no Redis/BullMQ, just a Postgres-backed
// queue (broadcast_recipients) polled on an interval, since a single Node
// process with a modest concurrency cap comfortably covers a small-to-mid
// tenant SaaS without adding a broker. Progress survives a process restart
// because it's row-based (FOR UPDATE SKIP LOCKED), not held in memory.
const { pool } = require('../db/pool');
const broadcastsRepo = require('../repositories/broadcastsRepo');
const broadcastRecipientsRepo = require('../repositories/broadcastRecipientsRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const chatsRepo = require('../repositories/chatsRepo');
const messagingService = require('../services/messagingService');
const { resolveParamValues, buildTemplateComponents } = require('../utils/templateParamMapping');
const logger = require('../utils/logger');
const { captureException } = require('../utils/errorTracking');
const { MessagingError } = messagingService;

const TICK_MS = 5000;
const BATCH_SIZE = 25;
const SEND_CONCURRENCY = 5; // well under Meta's lowest per-tier throughput cap

async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

async function sendOneRecipient(broadcast, recipient, template) {
  const contact = {
    id: recipient.contact_id,
    name: recipient.contact_name,
    phone: recipient.contact_phone,
    tag_id: recipient.contact_tag_id,
  };
  try {
    const chat = await chatsRepo.findOrCreateByContact(pool, broadcast.client_id, contact);
    // template is null when this template has no local row (see
    // routes/broadcasts.js's requiredParamNames comment — param validation
    // is skipped in that case, same reasoning applies here: nothing to
    // resolve components against, so send with none, same as before this
    // fix for that one edge case).
    const templateComponents = template
      ? buildTemplateComponents(template, resolveParamValues(broadcast.param_mappings, contact))
      : [];
    const message = await messagingService.sendChatMessage(pool, broadcast.client_id, chat, {
      type: 'template',
      templateName: broadcast.template_name,
      templateLanguage: 'en_US',
      templateComponents,
      headerMediaAssetId: broadcast.header_media_asset_id,
    });
    await broadcastRecipientsRepo.markSent(pool, recipient.id, message.id);
  } catch (err) {
    // Consent gate rejected it before any Cloud API call was made — skip,
    // not fail (build plan Phase 4). Reusing messagingService's own check
    // rather than re-implementing it here means there's exactly one place
    // that decides whether a template send needs consent.
    if (err instanceof MessagingError && err.code === 'consent_required') {
      await broadcastRecipientsRepo.markSkipped(pool, recipient.id, err.message);
    } else {
      await broadcastRecipientsRepo.markFailed(pool, recipient.id, err.message);
    }
  }
}

async function processBroadcast(broadcast) {
  const client = await pool.connect();
  // A checked-out client is a separate EventEmitter from the pool it came
  // from — pool.on('error', ...) (server/src/db/pool.js) only covers idle
  // clients still sitting in the pool, not one actively held here mid-
  // transaction. Same crash risk (see pool.js's comment for the mechanism),
  // different object; needs its own listener. This runs every 5s for the
  // life of the process, so it's held far more often than any single route.
  client.on('error', (err) => {
    logger.error({ err }, 'broadcastRunner: checked-out client error (non-fatal)');
    captureException(err);
  });
  let batch;
  try {
    await client.query('BEGIN');
    batch = await broadcastRecipientsRepo.claimBatch(client, broadcast.id, BATCH_SIZE);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (batch.length > 0) {
    // Fetched once per batch, not per recipient — the template row doesn't
    // change mid-broadcast, and every recipient in this batch needs the
    // same body/header parameter-name split (buildTemplateComponents).
    const template = await messageTemplatesRepo.findByNameAndClient(pool, broadcast.client_id, broadcast.template_name);
    await runWithConcurrency(batch, SEND_CONCURRENCY, (recipient) => sendOneRecipient(broadcast, recipient, template));
  }

  const stillPending = await broadcastRecipientsRepo.hasPending(pool, broadcast.id);
  if (!stillPending) {
    await broadcastsRepo.markStatus(pool, broadcast.id, 'Completed');
  }
}

async function tick() {
  try {
    const due = await broadcastsRepo.listDueScheduled(pool);
    for (const broadcast of due) {
      await broadcastsRepo.markStatus(pool, broadcast.id, 'Sending');
    }

    const active = await broadcastsRepo.listActive(pool);
    for (const broadcast of active) {
      await processBroadcast(broadcast);
    }
  } catch (err) {
    logger.error({ err }, 'broadcastRunner tick failed');
    captureException(err);
  }
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
}
function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, processBroadcast };
