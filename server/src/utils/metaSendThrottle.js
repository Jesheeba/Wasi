// Paces sends to Meta per WhatsApp number and retries Meta's throughput
// rejection (build-docs/features/meta-send-pacing.md).
//
// Why: Wasi used to pass every request straight to Meta. An n8n workflow
// fired 148 sends in 4 seconds and Meta refused part of them with
// "(#130429) Rate limit hit" (production, 2026-11-20/23/24/25). Other
// providers queue and pace; this does the same, in process: each phone
// number gets evenly spaced send slots, so a burst is smoothed instead of
// refused, and a 130429 that still happens is retried after a short wait.
//
// A 130429 means Meta did NOT accept the message, so retrying cannot send it
// twice. Nothing else is retried here: other errors (bad parameters, the
// recipient, policy) would fail the same way again.
//
// In-process: correct for the single app container this runs in. If the app
// is ever scaled to several containers, each would pace on its own.

const THROTTLE_CODE = 130429;

// Errors worth retrying: nothing about the message or recipient caused them
// (build-docs/features/send-retry-queue.md). Meta's documented temporary
// codes: 1/2 API unknown/unavailable, 4 app rate limit, 130429 throughput,
// 131000 something went wrong, 131016 service unavailable, 131056 pair rate
// limit, 133004 server temporarily unavailable. Without a Meta error body:
// no HTTP answer at all (fetch failed, connection reset/refused, DNS, our own
// timeout) or a 5xx. Shared with broadcastRunner.isTransientSendError.
const TRANSIENT_META_CODES = new Set([1, 2, 4, 130429, 131000, 131016, 131056, 133004]);
function isTransientMetaError(err) {
  if (!err) return false;
  if (err.metaError && err.metaError.code !== undefined && err.metaError.code !== null) {
    return TRANSIENT_META_CODES.has(Number(err.metaError.code));
  }
  return /timed out|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed|UND_ERR|Meta Graph API error \(5\d\d\)/i.test(err.message || '');
}

// Our own 20s timeout already waited a long time; don't repeat it inline,
// let the background queue retry it (messageRetryRunner).
const isTimeout = (err) => /timed out/i.test(err?.message || '');

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SendQueueFullError extends Error {
  constructor(waitMs) {
    super(`Too many messages are waiting to be sent from this WhatsApp number (about ${Math.ceil(waitMs / 1000)}s queued). Send in smaller batches, or try again shortly.`);
    this.code = 'send_queue_full';
  }
}

function createSendThrottle({
  perSecond = Number(process.env.META_SENDS_PER_SECOND) || 15,
  maxWaitMs = 60_000,
  retryDelaysMs = [1000, 2000, 4000],
  sleep = sleepMs,
  now = () => Date.now(),
} = {}) {
  const intervalMs = 1000 / perSecond;
  const nextSlotAt = new Map(); // key -> time the next send may start

  // Reserves the next free slot for `key` and waits for it.
  async function acquire(key) {
    const t = now();
    const slot = Math.max(t, nextSlotAt.get(key) || 0);
    const waitMs = slot - t;
    if (waitMs > maxWaitMs) throw new SendQueueFullError(waitMs);
    nextSlotAt.set(key, slot + intervalMs);
    if (waitMs > 0) await sleep(waitMs);
  }

  // Runs `send` in a paced slot for `key`; on a transient error (130429, a
  // network blip, a temporary Meta error - isTransientMetaError), waits and
  // runs it again (each retry takes a new slot), up to retryDelaysMs.length
  // times. A timeout is not retried inline (it already took 20s).
  // `retry: false` paces only - for the broadcast runner, which already
  // reschedules a transient failure itself and must not wait inline (its
  // tick is shared by every client's broadcasts).
  async function run(key, send, { retry = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      await acquire(key);
      try {
        return await send();
      } catch (err) {
        if (!retry || !isTransientMetaError(err) || isTimeout(err) || attempt >= retryDelaysMs.length) throw err;
        await sleep(retryDelaysMs[attempt]);
      }
    }
  }

  return { run, acquire };
}

// One shared instance for the app.
const defaultThrottle = createSendThrottle();

module.exports = {
  createSendThrottle,
  runPaced: (key, send, options) => defaultThrottle.run(key, send, options),
  SendQueueFullError,
  THROTTLE_CODE,
  isTransientMetaError,
};
