// All tenant tables carry client_id, indexed, so app-layer isolation (and later
// Postgres Row-Level Security policies) can filter every query by tenant.

exports.up = (pgm) => {
  pgm.createTable('tags', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    bg: { type: 'text' },
    color: { type: 'text' },
  });
  pgm.addConstraint('tags', 'tags_client_name_unique', { unique: ['client_id', 'name'] });
  pgm.createIndex('tags', 'client_id');

  pgm.createTable('contacts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    phone: { type: 'text', notNull: true },
    tag_id: { type: 'uuid', references: 'tags', onDelete: 'SET NULL' },
    status: { type: 'text', notNull: true, default: 'Active' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('contacts', 'contacts_client_phone_unique', { unique: ['client_id', 'phone'] });
  pgm.createIndex('contacts', 'client_id');

  pgm.createTable('chats', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    contact_id: { type: 'uuid', references: 'contacts', onDelete: 'SET NULL' },
    name: { type: 'text', notNull: true },
    phone: { type: 'text' },
    tag_id: { type: 'uuid', references: 'tags', onDelete: 'SET NULL' },
    last_message_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    unread_count: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.createIndex('chats', 'client_id');
  pgm.createIndex('chats', ['client_id', 'last_message_at']);

  pgm.createTable('messages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    chat_id: { type: 'uuid', notNull: true, references: 'chats', onDelete: 'CASCADE' },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    direction: { type: 'text', notNull: true, check: "direction in ('in', 'out')" },
    body: { type: 'text', notNull: true },
    sent_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('messages', ['chat_id', 'sent_at']);

  pgm.createTable('broadcasts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true },
    tag_id: { type: 'uuid', references: 'tags', onDelete: 'SET NULL' },
    status: { type: 'text', notNull: true, default: 'Scheduled' },
    delivered_count: { type: 'integer', notNull: true, default: 0 },
    read_rate: { type: 'numeric(5,2)', notNull: true, default: 0 },
    scheduled_date: { type: 'date' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('broadcasts', 'client_id');

  pgm.createTable('automation_rules', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true },
    trigger: { type: 'text', notNull: true },
    action: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'Enabled' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('automation_rules', 'client_id');
};

exports.down = (pgm) => {
  pgm.dropTable('automation_rules');
  pgm.dropTable('broadcasts');
  pgm.dropTable('messages');
  pgm.dropTable('chats');
  pgm.dropTable('contacts');
  pgm.dropTable('tags');
};
