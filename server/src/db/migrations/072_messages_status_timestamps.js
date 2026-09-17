// PLAN.md item 28 (broadcast per-recipient detail view), part A: the
// existing `messages.status` column is overwritten in place on every
// webhook update (chatsRepo.updateStatusByMetaId), with no record of WHEN
// it last transitioned to delivered/read/failed — only `sent_at` (row
// creation time) is ever stamped. A per-recipient drill-down needs to show
// a real "delivered at" / "read at" / "failed at" time, not just current
// status, so this adds the three missing columns.
//
// Nullable, no default — deliberately NOT backfilled from `sent_at` or
// anything else for existing rows. A message that was already delivered
// before this migration genuinely has no recorded delivery time; inventing
// one from `sent_at` would silently claim more precision than the data
// supports (same discipline as this file's other "don't fabricate a number
// the app doesn't have" precedents — conversation-pricing, tier estimation).
// The UI shows "—" for a null value rather than guessing.
exports.up = (pgm) => {
  pgm.addColumns('messages', {
    delivered_at: { type: 'timestamptz' },
    read_at: { type: 'timestamptz' },
    failed_at: { type: 'timestamptz' },
  });
};

exports.down = async (pgm) => {
  const [{ count }] = await pgm.db.select(
    'select count(*)::int as count from messages where delivered_at is not null or read_at is not null or failed_at is not null'
  );
  if (count > 0) {
    throw new Error(`Cannot roll back 072_messages_status_timestamps: ${count} messages row(s) have real timestamp data that would be lost.`);
  }
  pgm.dropColumns('messages', ['delivered_at', 'read_at', 'failed_at']);
};
