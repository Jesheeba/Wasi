async function enqueue(db, { clientId, wabaId, event, payload, targetUrl, targetSecret }) {
  await db.query(
    `insert into webhook_deliveries (client_id, waba_id, event, payload, target_url, target_secret)
     values ($1, $2, $3, $4, $5, $6)`,
    [clientId, wabaId, event, JSON.stringify(payload), targetUrl, targetSecret]
  );
}

// Claims a batch of due deliveries for forwardRunner.js. No separate
// 'sending' status — claiming just pushes next_attempt_at forward by a
// short lease window (below), which does the same job broadcast_recipients'
// status='sending' + claimed_at does (stop a second, overlapping tick from
// re-claiming the same rows) without needing its own status value or its
// own reclaim-if-stuck query. If the runner crashes mid-delivery, the lease
// simply expires and the row becomes claimable again on its own — no
// separate cleanup path needed.
const LEASE_MINUTES = 2;

async function claimBatch(db, limit) {
  const { rows } = await db.query(
    `update webhook_deliveries
     set next_attempt_at = now() + interval '${LEASE_MINUTES} minutes'
     where id in (
       select id from webhook_deliveries
       where status = 'pending' and next_attempt_at <= now()
       order by created_at asc
       limit $1
       for update skip locked
     )
     returning *`,
    [limit]
  );
  return rows;
}

async function markDelivered(db, id) {
  await db.query(
    `update webhook_deliveries set status = 'delivered', delivered_at = now() where id = $1`,
    [id]
  );
}

// Exponential backoff, capped: 1m, 5m, 30m, 2h, 6h — after MAX_ATTEMPTS
// failures the row is marked 'failed' permanently rather than retried
// forever, and logged loudly (see forwardRunner.js) so a dead consuming-app
// endpoint is something a human finds out about instead of silently
// retrying into the void.
const BACKOFF_MINUTES = [1, 5, 30, 120, 360];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

async function markFailedAttempt(db, id, errorMessage, attemptCountBefore) {
  const nextAttemptCount = attemptCountBefore + 1;
  const giveUp = nextAttemptCount >= MAX_ATTEMPTS;
  const backoffMinutes = BACKOFF_MINUTES[Math.min(nextAttemptCount - 1, BACKOFF_MINUTES.length - 1)];
  await db.query(
    `update webhook_deliveries
     set attempt_count = $2,
         status = $3,
         last_error = $4,
         next_attempt_at = now() + ($5 || ' minutes')::interval
     where id = $1`,
    [id, nextAttemptCount, giveUp ? 'failed' : 'pending', errorMessage, String(backoffMinutes)]
  );
  return { giveUp, nextAttemptCount };
}

module.exports = { enqueue, claimBatch, markDelivered, markFailedAttempt, MAX_ATTEMPTS };
