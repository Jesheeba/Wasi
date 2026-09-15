// Payment reminder + auto-suspend-for-nonpayment feature.
//
// activated_at: the only existing timestamp on `clients` is created_at
// (signup time) — nothing records when a client actually became an active,
// paying user, and status only ever transitions to 'active' via a manual
// admin action (grep-confirmed: nothing in this codebase sets
// status:'active' automatically). This column is set once, the moment
// status genuinely transitions to 'active' (routes/clients.js), and is what
// the monthly reminder's day-of-month cycle anchors to. Existing 'active'
// clients are backfilled from created_at below as a one-time, best-effort
// approximation (their real activation date isn't recorded anywhere) — not
// treated as exact, just the closest available proxy.
//
// payment_status/payment_marked_unpaid_at/payment_warning_sent_at/
// auto_suspended_for_nonpayment: there is no recurring-billing integration
// in this codebase (Razorpay is one-off Orders + wallet top-ups only, per
// billing.js's own comment) — nothing can auto-detect a missed payment.
// "Not paid" is therefore an admin-set flag, not a derived one. The 5-day
// suspend timeline is two-stage, not one shot: a day-3 warning (tracked by
// payment_warning_sent_at, sent once) and a day-5 auto-suspend (which also
// stamps auto_suspended_for_nonpayment so a later "mark paid" can tell this
// specific mechanism suspended the account — vs. an admin suspending for an
// unrelated reason — before silently reactivating it).
//
// last_reminder_sent_on: a DATE, not a timestamp — the monthly reminder
// runner ticks hourly (safety margin against restarts), so this exists
// purely to make "already sent today" idempotent across ticks.
exports.up = async (pgm) => {
  pgm.addColumns('clients', {
    activated_at: { type: 'timestamptz' },
    payment_status: { type: 'text', notNull: true, default: 'paid', check: "payment_status in ('paid', 'unpaid')" },
    payment_marked_unpaid_at: { type: 'timestamptz' },
    payment_warning_sent_at: { type: 'timestamptz' },
    auto_suspended_for_nonpayment: { type: 'boolean', notNull: true, default: false },
    last_reminder_sent_on: { type: 'date' },
  });

  pgm.sql(`update clients set activated_at = created_at where status = 'active' and activated_at is null`);
};

exports.down = async (pgm) => {
  pgm.dropColumns('clients', [
    'activated_at', 'payment_status', 'payment_marked_unpaid_at',
    'payment_warning_sent_at', 'auto_suspended_for_nonpayment', 'last_reminder_sent_on',
  ]);
};
