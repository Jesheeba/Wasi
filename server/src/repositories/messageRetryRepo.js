// Send retry queue on `messages` (migration 113,
// build-docs/features/send-retry-queue.md). The final outcome is written by
// chatsRepo.markSent / markFailed, which also clear the queue fields.

const FIRST_RETRY_SECONDS = 60;
const LEASE_SECONDS = 300;

// Keeps the message 'pending' and stores the Meta call to replay.
async function queue(db, clientId, messageId, sendRequest, reason) {
  const { rows } = await db.query(
    `update messages
        set send_request = $3, retry_count = 0, error_reason = $4,
            next_retry_at = now() + make_interval(secs => $5)
      where client_id = $1 and id = $2 and status = 'pending'
      returning *`,
    [clientId, messageId, JSON.stringify(sendRequest), reason, FIRST_RETRY_SECONDS]
  );
  return rows[0] || null;
}

// Claims due rows and leases them (next_retry_at pushed out) so a second
// runner, or the next tick, can't take the same row while it is being sent.
// CTE form: the IN (SELECT ... LIMIT) form ignored its LIMIT on PG17
// (broadcastRecipientsRepo.claimBatch, CLAUDE.md Known Gaps).
async function claimDue(db, limit = 20) {
  const { rows } = await db.query(
    `with due as (
       select id from messages
        where status = 'pending' and send_request is not null and next_retry_at <= now()
        order by next_retry_at
        limit $1
        for update skip locked
     )
     update messages m set next_retry_at = now() + make_interval(secs => $2)
       from due where m.id = due.id
     returning m.id, m.client_id, m.chat_id, m.send_request, m.retry_count`,
    [limit, LEASE_SECONDS]
  );
  return rows;
}

async function reschedule(db, clientId, messageId, retryCount, delaySeconds, reason) {
  await db.query(
    `update messages set retry_count = $3, next_retry_at = now() + make_interval(secs => $4), error_reason = $5
      where client_id = $1 and id = $2 and status = 'pending'`,
    [clientId, messageId, retryCount, delaySeconds, reason]
  );
}

module.exports = { queue, claimDue, reschedule, FIRST_RETRY_SECONDS, LEASE_SECONDS };
