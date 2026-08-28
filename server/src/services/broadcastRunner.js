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
const { MessagingError } = messagingService;

const TICK_MS = 5000;
const BATCH_SIZE = 25;
const SEND_CONCURRENCY = 5; // well under Meta's lowest per-tier throughput cap

// Per-broadcast pacing (wasi-master-plan.md §8.3, Phase 3) — optional,
// stored on broadcasts.pacing_config (migration 039). A broadcast with no
// pacing_config keeps the exact pre-Phase-3 behavior (BATCH_SIZE every
// tick, unchanged) — this only ever narrows the claim size, never widens
// it past BATCH_SIZE, since claiming more than SEND_CONCURRENCY can
// usefully process per tick anyway wouldn't change actual throughput.
// This paces THIS APP's own send rate against a client-configured ceiling
// (e.g. to protect a fresh/low-tier number's quality rating) — it is not,
// and isn't meant to be, live Meta throughput/tier enforcement (see
// migration 039's comment for why that's explicitly out of scope this
// phase). A slower real tick (send latency, DB round-trips) only ever
// makes the achieved rate slower than configured, never faster — safe for
// a rate ceiling.
// Independent audit found: `messages_per_minute` is only validated at the
// zod schema layer (validate.js's broadcastCreateSchema), unlike
// tag_id/contact_list_id's mutual exclusivity, which also has a DB CHECK
// constraint as a second guarantee — a non-numeric value reaching this
// column any other way (a future admin tool, a direct DB edit, a bug
// elsewhere) turns into `NaN` here, which Postgres rejects as a LIMIT
// parameter ("invalid input syntax for type bigint"). Confirmed this isn't
// just theoretical: that error propagates out of claimBatch, out of
// processBroadcast (whose own try/catch only wraps the claim transaction
// and rethrows), and tick()'s loop has one try/catch around the WHOLE
// loop — so one broadcast with a bad pacing_config would abort every
// OTHER active broadcast's processing for that tick, indefinitely (the bad
// broadcast stays 'Sending' and gets re-selected every 5s). Number.isFinite
// guards against this at the source rather than relying on tick()'s loop
// structure alone.
function effectiveBatchSize(broadcast) {
  const perMinute = broadcast.pacing_config?.messages_per_minute;
  if (!Number.isFinite(perMinute) || perMinute <= 0) return BATCH_SIZE;
  const perTick = Math.max(1, Math.floor((perMinute * TICK_MS) / 60000));
  return Math.min(BATCH_SIZE, perTick);
}

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
  // life of the process, so it's held far more often than any single route —
  // and pg.Pool reuses the same underlying Client object across separate
  // connect()/release() cycles, so the listener MUST be removed before
  // release(), not just added on connect(): found live (Phase 3 pacing
  // testing repeatedly calling processBroadcast in a tight loop, far more
  // per-minute than the real 5s tick would in practice) as a genuine
  // MaxListenersExceededWarning — a real, if previously invisible,
  // pre-existing accumulation, not introduced by pacing itself.
  const onClientError = (err) => {
    console.error('broadcastRunner: checked-out client error (non-fatal):', err.message);
  };
  client.on('error', onClientError);
  let batch;
  try {
    await client.query('BEGIN');
    batch = await broadcastRecipientsRepo.claimBatch(client, broadcast.id, effectiveBatchSize(broadcast));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.removeListener('error', onClientError);
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
      // Independent audit finding: a single try/catch around this whole
      // loop means one broadcast throwing (the NaN pacing_config case
      // above, or any other future error) aborts every OTHER client's
      // active broadcast for this tick too — not just the bad one, and not
      // just once, since the bad broadcast stays 'Sending' and gets
      // re-selected every 5s indefinitely. Isolated per-broadcast so one
      // client's broken campaign can't starve everyone else's.
      try {
        await processBroadcast(broadcast);
      } catch (err) {
        console.error(`broadcastRunner: processBroadcast failed for broadcast ${broadcast.id} (non-fatal, other broadcasts continue):`, err.message);
      }
    }
  } catch (err) {
    console.error('broadcastRunner tick failed:', err.message);
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
