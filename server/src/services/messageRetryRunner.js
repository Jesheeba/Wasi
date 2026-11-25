// Replays queued sends (build-docs/features/send-retry-queue.md).
//
// messagingService.sendChatMessage queues a message ('pending' +
// send_request) when Meta could not be reached or answered with a temporary
// error, after the pacer's inline retries. This runner, every 15s, claims
// due rows, reloads the client's WhatsApp number and token, and replays the
// stored Meta call through the same pacer. Same shape as forwardRunner /
// broadcastRunner: privileged pool, per-row try/catch, start/stop.
const { pool } = require('../db/pool');
const wabasRepo = require('../repositories/wabasRepo');
const chatsRepo = require('../repositories/chatsRepo');
const usageRepo = require('../repositories/usageRepo');
const messageRetryRepo = require('../repositories/messageRetryRepo');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');
const { runPaced, isTransientMetaError } = require('../utils/metaSendThrottle');

const TICK_MS = 15_000;
// Waits before retry 1, 2, ... (seconds): 1, 2, 5, 10, 20, 30 minutes after
// the first queued retry - about 70 minutes in all, then the message fails.
const BACKOFF_SECONDS = [120, 300, 600, 1200, 1800];
const MAX_RETRIES = BACKOFF_SECONDS.length + 1;

// Only these metaClient functions may be replayed from a stored row.
const REPLAYABLE = new Set([
  'sendTextMessage', 'sendTemplateMessage', 'sendInteractiveMessage', 'sendListMessage', 'sendFlowMessage', 'sendProductMessage',
]);

async function processRow(row) {
  const { id, client_id: clientId, send_request: call } = row;
  const attempt = (row.retry_count || 0) + 1;
  if (!call || !REPLAYABLE.has(call.fn) || !Array.isArray(call.args)) {
    await chatsRepo.markFailed(pool, clientId, id, 'Could not retry: the stored send request is not valid.');
    return 'failed';
  }
  const waba = await wabasRepo.findByClientId(clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) {
    await chatsRepo.markFailed(pool, clientId, id, 'Could not retry: no connected WhatsApp number for this account.');
    return 'failed';
  }
  try {
    const accessToken = decrypt(waba.access_token_encrypted);
    const metaMessageId = await runPaced(waba.phone_number_id,
      () => metaClient[call.fn](waba.phone_number_id, accessToken, ...call.args));
    await chatsRepo.markSent(pool, clientId, id, metaMessageId);
    await usageRepo.incrementSent(pool, clientId);
    return 'sent';
  } catch (err) {
    const reason = `${err.message} (retry ${attempt})`;
    if (isTransientMetaError(err) && attempt < MAX_RETRIES) {
      await messageRetryRepo.reschedule(pool, clientId, id, attempt, BACKOFF_SECONDS[attempt - 1], `Queued for retry: ${reason}`);
      return 'rescheduled';
    }
    await chatsRepo.markFailed(pool, clientId, id,
      isTransientMetaError(err) ? `Gave up after ${attempt} retries: ${err.message}` : err.message,
      err.metaError?.code, err.metaError?.error_subcode);
    return 'failed';
  }
}

async function tick() {
  let rows = [];
  try {
    rows = await messageRetryRepo.claimDue(pool);
  } catch (err) {
    console.error('[messageRetryRunner] claim failed:', err.message);
    return;
  }
  for (const row of rows) {
    try {
      await processRow(row);
    } catch (err) {
      // The lease expires and the row is tried again later.
      console.error(`[messageRetryRunner] message ${row.id} failed to process:`, err.message);
    }
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

module.exports = { start, stop, tick, processRow, BACKOFF_SECONDS, MAX_RETRIES };
