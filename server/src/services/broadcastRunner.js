// Background campaign fan-out — no Redis/BullMQ, just a Postgres-backed
// queue (broadcast_recipients) polled on an interval, since a single Node
// process with a modest concurrency cap comfortably covers a small-to-mid
// tenant SaaS without adding a broker. Progress survives a process restart
// because it's row-based (FOR UPDATE SKIP LOCKED), not held in memory.
const { pool } = require('../db/pool');
const broadcastsRepo = require('../repositories/broadcastsRepo');
const broadcastRecipientsRepo = require('../repositories/broadcastRecipientsRepo');
const chatsRepo = require('../repositories/chatsRepo');
const messagingService = require('../services/messagingService');

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

async function sendOneRecipient(broadcast, recipient) {
  const contact = {
    id: recipient.contact_id,
    name: recipient.contact_name,
    phone: recipient.contact_phone,
    tag_id: recipient.contact_tag_id,
  };
  try {
    const chat = await chatsRepo.findOrCreateByContact(broadcast.client_id, contact);
    const message = await messagingService.sendChatMessage(broadcast.client_id, chat, {
      type: 'template',
      templateName: broadcast.template_name,
      templateLanguage: 'en_US',
      templateComponents: [],
    });
    await broadcastRecipientsRepo.markSent(recipient.id, message.id);
  } catch (err) {
    await broadcastRecipientsRepo.markFailed(recipient.id, err.message);
  }
}

async function processBroadcast(broadcast) {
  const client = await pool.connect();
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
    await runWithConcurrency(batch, SEND_CONCURRENCY, (recipient) => sendOneRecipient(broadcast, recipient));
  }

  const stillPending = await broadcastRecipientsRepo.hasPending(broadcast.id);
  if (!stillPending) {
    await broadcastsRepo.markStatus(broadcast.id, 'Completed');
  }
}

async function tick() {
  try {
    const due = await broadcastsRepo.listDueScheduled();
    for (const broadcast of due) {
      await broadcastsRepo.markStatus(broadcast.id, 'Sending');
    }

    const active = await broadcastsRepo.listActive();
    for (const broadcast of active) {
      await processBroadcast(broadcast);
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

module.exports = { start, stop, tick };
