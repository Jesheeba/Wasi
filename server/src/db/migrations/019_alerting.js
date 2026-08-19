// Phase 6 Part C — the alerting engine's only schema need: one table
// tracking alert state so alertRunner.js (a 5-minute setInterval poller,
// same shape as broadcastRunner.js/forwardRunner.js) can tell "newly
// detected, notify" from "already open, don't re-notify" from "no longer
// reproducing, resolve" — without that, every 5-minute tick would re-send
// the same email forever for as long as a condition stays true.
//
// The partial unique index enforces "at most one OPEN alert per
// (alert_type, dedup_key)" at the database level, not just in application
// logic — a second detection of the same still-open condition can only
// UPDATE the existing row (touching last_seen_at), never insert a
// duplicate, even under concurrent runner ticks.
//
// No RLS/wasi_app grant — same treatment as audit_log/admin_users/
// meta_webhook_log: platform-internal, privileged-connection-only.
exports.up = (pgm) => {
  pgm.createTable('alert_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    alert_type: { type: 'text', notNull: true },
    dedup_key: { type: 'text', notNull: true },
    severity: {
      type: 'text',
      notNull: true,
      default: 'warning',
      check: "severity in ('info', 'warning', 'critical')",
    },
    message: { type: 'text', notNull: true },
    details: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    first_detected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    resolved_at: { type: 'timestamptz' },
    notified_at: { type: 'timestamptz' },
  });

  pgm.sql(`
    create unique index alert_events_open_dedup
      on alert_events (alert_type, dedup_key)
      where resolved_at is null
  `);
  pgm.createIndex('alert_events', ['alert_type', 'dedup_key']);
};

exports.down = (pgm) => {
  pgm.dropTable('alert_events');
};
