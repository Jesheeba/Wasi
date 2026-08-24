// Idempotency ledger for handleStatuses' message.status forwards
// (metaWebhook.js) — a Meta redelivery of the same status webhook must not
// produce a second forward to the client's CRM. Deliberately NOT the same
// guard as messages.meta_message_id's UNIQUE constraint (migration
// 006_messaging.js): that one only covers the inbound-message INSERT path
// (chatsRepo.insertInbound's ON CONFLICT DO NOTHING) and says nothing about
// this UPDATE-only status path — messages.status is a single mutable
// column, not an append-only log, so it has no natural per-event
// uniqueness of its own to lean on.
//
// Keyed on (meta_message_id, status), not meta_message_id alone — a real
// sent -> delivered -> read progression for the same message is 3 distinct
// pairs and must still forward each one; only an exact repeat of the same
// pair (a genuine redelivery) should be suppressed.
//
// No client_id / RLS here, unlike webhook_deliveries and api_keys
// (migration 014_hub_capability.js): this table is written and read only
// from metaWebhook.js on the privileged connection, never exposed through
// any wasi_app-scoped route, and meta_message_id is already treated as a
// globally unique key elsewhere (messages_meta_message_id_unique carries no
// per-client scoping either).
exports.up = (pgm) => {
  pgm.createTable('message_status_forwards', {
    meta_message_id: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    forwarded_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('message_status_forwards', 'message_status_forwards_pkey', {
    primaryKey: ['meta_message_id', 'status'],
  });
};

exports.down = (pgm) => {
  pgm.dropTable('message_status_forwards');
};
