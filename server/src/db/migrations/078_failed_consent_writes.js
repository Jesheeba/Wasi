// Consent hardening Phase 1 — a durable landing place for a consent write
// that failed even after a retry. Today the only caller that needs this is
// the inbound STOP path (metaWebhook.js, via consentRepo.recordOptOutDurable):
// an opt-out has no human on the other end to retry it themselves, so a lost
// write is a compliance failure, not just a data gap — it must never
// silently disappear into a console.error the way it used to.
//
// Platform-internal, privileged-connection-only — same treatment as
// alert_events/audit_log/meta_webhook_log (see migration 019_alerting.js's
// module comment): no RLS, no wasi_app grant, nothing client-facing reads
// this table in Phase 1. `contact_id` is NOT a foreign key on purpose — if
// the contacts write itself is what's failing (the same underlying DB
// trouble that caused this row to exist at all), a hard FK could make even
// this fallback insert fail; a dangling id here is still useful evidence of
// what was attempted, so favor "always writes" over "the reference is
// always live." Deliberately no automated replay in Phase 1 — resolved_at
// exists so a human (or a future phase) can mark a row handled after acting
// on it, matching alert_events' own resolved_at shape.
exports.up = (pgm) => {
  pgm.createTable('failed_consent_writes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    contact_id: { type: 'uuid' },
    event: { type: 'text', notNull: true, check: "event in ('opted_in', 'opted_out')" },
    source: { type: 'text', notNull: true },
    evidence: { type: 'jsonb' },
    error_message: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    resolved_at: { type: 'timestamptz' },
  });
  pgm.createIndex('failed_consent_writes', 'client_id');
  pgm.createIndex('failed_consent_writes', 'contact_id');
};

exports.down = async (pgm) => {
  const [{ count }] = await pgm.db.select(
    'select count(*)::int as count from failed_consent_writes where resolved_at is null'
  );
  if (count > 0) {
    throw new Error(`Cannot roll back 078_failed_consent_writes: ${count} unresolved row(s) would be lost — resolve or manually archive them first.`);
  }
  pgm.dropTable('failed_consent_writes');
};
