// Delivers everything routes/metaWebhook.js's enqueueForwards() enqueues
// (build plan Phase 5) — both wabas.forward_to_url (a hub-connected
// consuming app) and client_webhooks.callback_url (a client's own
// self-configured integration webhook) feed the same webhook_deliveries
// queue and get delivered by this one runner; there's no per-target logic
// here, a delivery row doesn't record which kind of target it came from.
// A Postgres-backed retry queue polled on an interval, same shape as
// broadcastRunner.js and for the same reason (FOR UPDATE SKIP LOCKED,
// row-based so progress survives a process restart, no broker needed at
// this scale).
//
// CRITICAL, and the whole reason this exists as a separate poller rather
// than an inline await in metaWebhook.js: the actual HTTP delivery attempt
// must never happen inside the request that's answering Meta. metaWebhook.js
// only ever does a fast, local enqueue (webhookDeliveriesRepo.enqueue) in
// the same success path as its other writes — a failed enqueue is a
// genuine processing failure (correctly triggers the existing 500-so-Meta-
// retries behavior), but a failed *delivery* to the consuming app, or that
// app's endpoint being slow, must never turn into a non-200 to Meta. This
// runner is what keeps those two failure modes from ever touching each
// other.
const crypto = require('crypto');
const { pool } = require('../db/pool');
const webhookDeliveriesRepo = require('../repositories/webhookDeliveriesRepo');
const logger = require('../utils/logger');
const { captureException } = require('../utils/errorTracking');

const TICK_MS = 5000;
const BATCH_SIZE = 25;
const DELIVER_CONCURRENCY = 5;
const DELIVERY_TIMEOUT_MS = 10_000;

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

async function deliverOne(delivery) {
  const body = JSON.stringify({ event: delivery.event, data: delivery.payload });
  const signature = crypto.createHmac('sha256', delivery.target_secret).update(body).digest('hex');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(delivery.target_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wasi-signature-256': `sha256=${signature}` },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error(`target responded ${res.status}`);
    await webhookDeliveriesRepo.markDelivered(pool, delivery.id);
  } catch (err) {
    const { giveUp, nextAttemptCount } = await webhookDeliveriesRepo.markFailedAttempt(
      pool, delivery.id, err.message, delivery.attempt_count
    );
    // Loud and structured on purpose, matching metaWebhook.js's "metaWebhook
    // FAILURE:" convention — grep-able, meant to be wired to an alert (see
    // wasi-build-plan.md §6.1) rather than scrolled past. Not sent to Sentry
    // (errorTracking.js): a consuming app's endpoint being down/slow is an
    // external-target failure, not a bug in this codebase — alertRunner.js's
    // checkWebhookDeliveryFailures already surfaces sustained failures of
    // this kind as a proper alert, batched per client per day.
    logger.error({
      deliveryId: delivery.id,
      clientId: delivery.client_id,
      event: delivery.event,
      attempt: nextAttemptCount,
      err,
    }, giveUp ? 'webhookForward PERMANENT FAILURE' : 'webhookForward retry scheduled');
  }
}

async function tick() {
  try {
    const batch = await webhookDeliveriesRepo.claimBatch(pool, BATCH_SIZE);
    if (batch.length > 0) {
      await runWithConcurrency(batch, DELIVER_CONCURRENCY, deliverOne);
    }
  } catch (err) {
    logger.error({ err }, 'forwardRunner tick failed');
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

module.exports = { start, stop, tick, deliverOne };
