// Queue storage for the AI agent runner (migration 088). Modelled on
// webhookDeliveriesRepo.js (lease-at-insert, claim by pushing
// next_attempt_at forward, bounded backoff, terminal 'failed') with the two
// changes the migration's own comment explains. Every function takes `db`
// first (the privileged pool in production; any pg Pool/Client in tests).
//
// Status lifecycle:
//   enqueue            -> processing (attempt 1, leased)
//   handler succeeds   -> done
//   handler fails      -> pending (backoff) or, out of attempts, failed
//   lease expires      -> claimable again (attempt_count already counted)
//   attempts exhausted -> failed, via sweepExhausted

const LEASE_SECONDS = 120;
// Three attempts, not forwardRunner's five: an answer to a customer who asked
// a question is worth little hours later, and a handover to a human is the
// right fallback (SPEC section 15). Backoff after failed attempt n waits
// BACKOFF_SECONDS[n - 1].
const MAX_ATTEMPTS = 3;
const BACKOFF_SECONDS = [30, 120, 600];
// The reply must be sendable: a job older than Meta's 24-hour service window
// is failed, not retried (SPEC section 6).
const WINDOW_MS = 24 * 60 * 60 * 1000;
const PURGE_AFTER_DAYS = 7;

// Inserts the job already leased and already counted as attempt 1, so the
// periodic tick can never race the immediate attempt (same reasoning as
// webhookDeliveriesRepo.enqueue). Returns null when a job already exists for
// this inbound message (a redelivered webhook).
async function enqueue(db, { clientId, conversationId, inboundMessageId }, { leaseSeconds = LEASE_SECONDS } = {}) {
  const { rows } = await db.query(
    `insert into ai_jobs (client_id, conversation_id, inbound_message_id, status, attempt_count, next_attempt_at)
     values ($1, $2, $3, 'processing', 1, now() + make_interval(secs => $4::double precision))
     on conflict (inbound_message_id) do nothing
     returning *`,
    [clientId, conversationId, inboundMessageId, leaseSeconds]
  );
  return rows[0] || null;
}

// Claims due jobs. The CTE form with FOR UPDATE SKIP LOCKED is deliberate and
// is NOT the `where id in (select ... limit ... for update skip locked)` form
// webhookDeliveriesRepo.claimBatch still uses: that shape did not reliably
// honour its LIMIT under the outer UPDATE on the production Postgres (see
// CLAUDE.md, broadcastRecipientsRepo.claimBatch).
//
// attempt_count is incremented here, so a claim that is never completed still
// spends an attempt. Rows already at the attempt cap are not selected; they
// are failed by sweepExhausted.
async function claimDueBatch(db, limit, { leaseSeconds = LEASE_SECONDS, maxAttempts = MAX_ATTEMPTS } = {}) {
  const { rows } = await db.query(
    `with due as (
       select id from ai_jobs
        where status in ('pending', 'processing')
          and next_attempt_at <= now()
          and attempt_count < $2
        order by created_at asc
        limit $1
        for update skip locked
     )
     update ai_jobs j
        set status = 'processing',
            attempt_count = j.attempt_count + 1,
            next_attempt_at = now() + make_interval(secs => $3::double precision)
       from due
      where j.id = due.id
      returning j.*`,
    [limit, maxAttempts, leaseSeconds]
  );
  return rows;
}

// Jobs that ran out of attempts without ever reporting a result (every claim
// died mid-flight). Fails them so they cannot sit forever, and returns them so
// the caller can record the terminal transition exactly once.
async function sweepExhausted(db, { maxAttempts = MAX_ATTEMPTS } = {}) {
  const { rows } = await db.query(
    `update ai_jobs
        set status = 'failed',
            finished_at = now(),
            last_error = coalesce(last_error, 'worker never reported a result') || ' (attempts exhausted)'
      where status in ('pending', 'processing')
        and next_attempt_at <= now()
        and attempt_count >= $1
      returning *`,
    [maxAttempts]
  );
  return rows;
}

// Completion is guarded by the attempt number the worker was handed. A worker
// whose lease expired (and whose job was claimed again) matches no row, so a
// stale result can never overwrite the live attempt's.
async function markDone(db, job) {
  const { rowCount } = await db.query(
    `update ai_jobs
        set status = 'done', finished_at = now(), last_error = null
      where id = $1 and status = 'processing' and attempt_count = $2`,
    [job.id, job.attempt_count]
  );
  return rowCount === 1;
}

async function markFailedAttempt(db, job, errorMessage, { maxAttempts = MAX_ATTEMPTS, backoffSeconds = BACKOFF_SECONDS } = {}) {
  const giveUp = job.attempt_count >= maxAttempts;
  const wait = backoffSeconds[Math.min(job.attempt_count - 1, backoffSeconds.length - 1)];
  const { rowCount } = await db.query(
    `update ai_jobs
        set status = $3,
            last_error = $4,
            next_attempt_at = now() + make_interval(secs => $5::double precision),
            finished_at = case when $3 = 'failed' then now() else null end
      where id = $1 and status = 'processing' and attempt_count = $2`,
    [job.id, job.attempt_count, giveUp ? 'failed' : 'pending', errorMessage, wait]
  );
  return { applied: rowCount === 1, giveUp };
}

// A failure that retrying cannot fix (the 24-hour window has closed).
async function markFailedTerminal(db, job, reason) {
  const { rowCount } = await db.query(
    `update ai_jobs
        set status = 'failed', last_error = $3, finished_at = now()
      where id = $1 and status = 'processing' and attempt_count = $2`,
    [job.id, job.attempt_count, reason]
  );
  return rowCount === 1;
}

// Retention: finished rows are only useful for a short debugging window.
async function purgeFinished(db, { olderThanDays = PURGE_AFTER_DAYS } = {}) {
  const { rowCount } = await db.query(
    `delete from ai_jobs
      where status in ('done', 'failed')
        and finished_at < now() - make_interval(days => $1::int)`,
    [olderThanDays]
  );
  return rowCount;
}

async function findById(db, id) {
  const { rows } = await db.query('select * from ai_jobs where id = $1', [id]);
  return rows[0] || null;
}

module.exports = {
  enqueue, claimDueBatch, sweepExhausted, markDone, markFailedAttempt, markFailedTerminal,
  purgeFinished, findById,
  LEASE_SECONDS, MAX_ATTEMPTS, BACKOFF_SECONDS, WINDOW_MS, PURGE_AFTER_DAYS,
};
