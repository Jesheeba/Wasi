// Durable, resumable campaign fan-out: each recipient is a row so the
// broadcastRunner background loop can claim work in batches (FOR UPDATE SKIP
// LOCKED) and survive a process restart mid-send without losing progress or
// double-sending completed recipients. Real delivered/read numbers are
// computed by joining to `messages` at read time (see broadcastsRepo.list) —
// not duplicated here — so there's one source of truth for message status.

exports.up = (pgm) => {
  pgm.addColumn('broadcasts', {
    template_name: { type: 'text' },
  });

  pgm.createTable('broadcast_recipients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    broadcast_id: { type: 'uuid', notNull: true, references: 'broadcasts', onDelete: 'CASCADE' },
    contact_id: { type: 'uuid', references: 'contacts', onDelete: 'SET NULL' },
    message_id: { type: 'uuid', references: 'messages', onDelete: 'SET NULL' },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      // 'sending' is a claimed-but-not-yet-resolved state: the runner sets it
      // in the same transaction as the claiming SELECT so a second, overlapping
      // tick (a slow batch can outlast the 5s tick interval) can't re-claim
      // the same rows once the claim transaction commits and releases its lock.
      check: "status in ('pending','sending','sent','failed')",
    },
    error_reason: { type: 'text' },
    claimed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('broadcast_recipients', 'broadcast_id');
  pgm.createIndex('broadcast_recipients', ['broadcast_id', 'status']);
};

exports.down = (pgm) => {
  pgm.dropTable('broadcast_recipients');
  pgm.dropColumn('broadcasts', 'template_name');
};
