exports.up = (pgm) => {
  pgm.createTable('support_tickets', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    subject: { type: 'text', notNull: true },
    message: { type: 'text', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'open',
      check: "status in ('open', 'in_progress', 'resolved', 'closed')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('support_tickets', 'client_id');
  pgm.createIndex('support_tickets', 'status');
};

exports.down = (pgm) => {
  pgm.dropTable('support_tickets');
};
