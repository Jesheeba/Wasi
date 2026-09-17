// Load-analysis follow-up (2026-09-16 session): a broadcast recipient that
// hit a transient send failure (Meta rate-limit rejection, a network
// timeout) was previously marked 'failed' permanently on the very first
// attempt — the same terminal treatment as a genuinely permanent rejection
// (invalid template, bad phone, disabled account). This adds the two
// columns broadcastRecipientsRepo.markFailedAttempt (server/src/repositories/
// broadcastRecipientsRepo.js) needs to retry with backoff instead: how many
// times this recipient has been attempted, and when it's next eligible to
// be reclaimed. Mirrors webhook_deliveries' attempt_count/next_attempt_at
// shape (migration 014_hub_capability.js) — not identical scale, see
// broadcastRecipientsRepo.js's own BACKOFF_SECONDS comment for why a
// campaign uses a much shorter
// schedule than the webhook forwarder's hours-long one.
//
// next_attempt_at defaults to now() so every existing/newly-inserted row is
// immediately claimable, exactly matching current behavior — this migration
// changes nothing for a recipient that never needs a retry.
exports.up = (pgm) => {
  pgm.addColumns('broadcast_recipients', {
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    next_attempt_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = async (pgm) => {
  // Live-row guard, same precedent as 055/070's down()s — attempt_count > 0
  // means a real retry actually happened for that row; dropping the column
  // silently discards that history rather than just an unused default.
  const [{ count }] = await pgm.db.select('select count(*)::int as count from broadcast_recipients where attempt_count > 0');
  if (count > 0) {
    throw new Error(`Cannot roll back 071_broadcast_recipients_retry: ${count} broadcast_recipients row(s) have real retry history (attempt_count > 0) that would be lost.`);
  }
  pgm.dropColumns('broadcast_recipients', ['attempt_count', 'next_attempt_at']);
};
