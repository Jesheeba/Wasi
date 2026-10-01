// Admin-defined monthly schedules for the payment reminder: "on day N of every
// month, at hour H (India time), send the reminder to every active client."
// Distinct from the pre-existing per-client reminder anchored to each client's
// own activated_at day (paymentReminderRunner.sendReminderIfDue) — that one is
// automatic and per-client; this one is a single admin-chosen date for
// everyone.
//
// last_run_on is the once-per-day guard: paymentReminderRunner claims a
// schedule with a conditional UPDATE on it before sending, so two server
// instances (or two ticks in the same hour) can never both fire it.
// Platform-internal, privileged connection only — no wasi_app grant.
//
// Also widens payment_notifications.trigger (migration 084) with
// 'admin_schedule' so a scheduled-by-admin send is distinguishable in the
// audit page from the per-client monthly one ('scheduled') and a manual
// "send now" ('manual_bulk').
exports.up = (pgm) => {
  pgm.createTable('payment_reminder_schedules', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    day_of_month: { type: 'smallint', notNull: true, check: 'day_of_month between 1 and 31' },
    send_hour: { type: 'smallint', notNull: true, default: 10, check: 'send_hour between 0 and 23' },
    enabled: { type: 'boolean', notNull: true, default: true },
    last_run_on: { type: 'date' },
    last_run_summary: { type: 'text' },
    created_by: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.sql('alter table payment_notifications drop constraint payment_notifications_trigger_check');
  pgm.sql(`alter table payment_notifications add constraint payment_notifications_trigger_check
    check (trigger in ('scheduled', 'nonpayment_timeline', 'manual_bulk', 'admin_schedule'))`);
};

exports.down = (pgm) => {
  pgm.sql("update payment_notifications set trigger = 'manual_bulk' where trigger = 'admin_schedule'");
  pgm.sql('alter table payment_notifications drop constraint payment_notifications_trigger_check');
  pgm.sql(`alter table payment_notifications add constraint payment_notifications_trigger_check
    check (trigger in ('scheduled', 'nonpayment_timeline', 'manual_bulk'))`);
  pgm.dropTable('payment_reminder_schedules');
};
