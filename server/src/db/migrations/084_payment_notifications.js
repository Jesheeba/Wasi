// Audit trail for every WhatsApp message Wasi itself sends to one of its own
// clients about billing (payment reminder, suspension warning, suspension
// notice) — who it went to, when, and how far it got (sent -> delivered ->
// read, or failed and why). Before this, paymentReminderRunner/clientNotifier
// recorded only a bare audit_log "reminder sent" line, written even when the
// send itself failed, and never captured Meta's message id — so delivery and
// read receipts for these messages had nowhere to land.
//
// Platform-internal, privileged connection only (same treatment as
// audit_log/alert_events): no RLS, no wasi_app grant. client_id is ON DELETE
// SET NULL with a client_name/recipient_phone snapshot, so deleting a client
// never erases the record that a reminder was sent to them — it is an audit
// table, retention matters more than referential tidiness.
exports.up = (pgm) => {
  pgm.createTable('payment_notifications', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', references: 'clients', onDelete: 'SET NULL' },
    client_name: { type: 'text', notNull: true },
    recipient_phone: { type: 'text' },
    kind: { type: 'text', notNull: true, check: "kind in ('payment_reminder', 'suspension_warning', 'service_suspended')" },
    trigger: { type: 'text', notNull: true, check: "trigger in ('scheduled', 'nonpayment_timeline', 'manual_bulk')" },
    template_name: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, check: "status in ('sent', 'delivered', 'read', 'failed')" },
    meta_message_id: { type: 'text' },
    error_message: { type: 'text' },
    triggered_by: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    sent_at: { type: 'timestamptz' },
    delivered_at: { type: 'timestamptz' },
    read_at: { type: 'timestamptz' },
    failed_at: { type: 'timestamptz' },
  });
  pgm.createIndex('payment_notifications', 'meta_message_id');
  pgm.createIndex('payment_notifications', ['client_id', 'created_at']);
  pgm.createIndex('payment_notifications', 'created_at');
};

exports.down = (pgm) => {
  pgm.dropTable('payment_notifications');
};
