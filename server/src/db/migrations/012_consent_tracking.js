// Opt-in/consent tracking (build plan Phase 4). Not a feature — a blocker:
// before this, nothing in the schema distinguished a contact who consented
// to marketing messages from one who never has. Quality ratings are
// assessed at Business Portfolio level, not per phone number, so one
// client's unsolicited sends degrade the messaging tier for every other
// client on the account.
//
// Existing contacts default to 'unknown' on this migration, same as any new
// one — consent can't be retroactively assumed for rows recorded before it
// was tracked. Do not backfill 'unknown' to 'opted_in' for any reason.

exports.up = (pgm) => {
  pgm.addColumns('contacts', {
    opt_in_status: {
      type: 'text',
      notNull: true,
      default: 'unknown',
      check: "opt_in_status in ('unknown', 'opted_in', 'opted_out')",
    },
    opt_in_source: { type: 'text' },
    opt_in_at: { type: 'timestamptz' },
    opt_out_at: { type: 'timestamptz' },
  });

  // Append-only — no update()/remove() in the repo layer for this table by
  // design. Changing consent creates a new row; this is the record a
  // client's sending practices would be judged against if ever challenged.
  pgm.createTable('consent_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    contact_id: { type: 'uuid', notNull: true, references: 'contacts', onDelete: 'CASCADE' },
    event: { type: 'text', notNull: true, check: "event in ('opted_in', 'opted_out')" },
    source: { type: 'text', notNull: true },
    evidence: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('consent_events', 'client_id');
  pgm.createIndex('consent_events', 'contact_id');

  // broadcast_recipients.status previously only covered actual send
  // attempts ('pending'/'sending'/'sent'/'failed') — a non-opted-in
  // recipient is deliberately never attempted, so it needs its own status
  // rather than being reported as a failure that didn't happen.
  pgm.dropConstraint('broadcast_recipients', 'broadcast_recipients_status_check');
  pgm.addConstraint('broadcast_recipients', 'broadcast_recipients_status_check', {
    check: "status in ('pending', 'sending', 'sent', 'failed', 'skipped')",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('broadcast_recipients', 'broadcast_recipients_status_check');
  pgm.addConstraint('broadcast_recipients', 'broadcast_recipients_status_check', {
    check: "status in ('pending', 'sending', 'sent', 'failed')",
  });
  pgm.dropTable('consent_events');
  pgm.dropColumns('contacts', ['opt_in_status', 'opt_in_source', 'opt_in_at', 'opt_out_at']);
};
