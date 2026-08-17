exports.up = (pgm) => {
  pgm.createTable('clients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    email: { type: 'text', notNull: true, unique: true },
    password_hash: { type: 'text' },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending_setup',
      check: "status in ('pending_setup', 'payment_confirmed', 'active', 'suspended')",
    },
    tenant_slug: { type: 'text', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('subscriptions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: {
      type: 'uuid',
      notNull: true,
      references: 'clients',
      onDelete: 'CASCADE',
    },
    plan: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'active' },
    renews_at: { type: 'timestamptz' },
    payment_provider_ref: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('subscriptions', 'client_id');

  pgm.createTable('wabas', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: {
      type: 'uuid',
      notNull: true,
      references: 'clients',
      onDelete: 'CASCADE',
    },
    waba_id: { type: 'text', unique: true },
    phone_number_id: { type: 'text' },
    display_name: { type: 'text' },
    quality_rating: { type: 'text' },
    access_token_encrypted: { type: 'text' },
    verified_at: { type: 'timestamptz' },
    status: { type: 'text', notNull: true, default: 'pending' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('wabas', 'client_id');

  // Doubles as the CRM "message templates" list (unifies spec §4 with the mock state.templates shape).
  pgm.createTable('message_templates', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: {
      type: 'uuid',
      notNull: true,
      references: 'clients',
      onDelete: 'CASCADE',
    },
    name: { type: 'text', notNull: true },
    category: { type: 'text' },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "status in ('approved', 'pending', 'rejected')",
    },
    body: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('message_templates', 'client_id');

  pgm.createTable('usage_logs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: {
      type: 'uuid',
      notNull: true,
      references: 'clients',
      onDelete: 'CASCADE',
    },
    date: { type: 'date', notNull: true },
    messages_sent: { type: 'integer', notNull: true, default: 0 },
    messages_received: { type: 'integer', notNull: true, default: 0 },
    conversations_billed: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('usage_logs', 'usage_logs_client_date_unique', {
    unique: ['client_id', 'date'],
  });

  pgm.createTable('admin_users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    email: { type: 'text', notNull: true, unique: true },
    role: {
      type: 'text',
      notNull: true,
      check: "role in ('super_admin', 'support', 'billing')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('audit_log', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    actor_type: { type: 'text', notNull: true },
    actor_id: { type: 'uuid' },
    action: { type: 'text', notNull: true },
    target: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('audit_log');
  pgm.dropTable('admin_users');
  pgm.dropTable('usage_logs');
  pgm.dropTable('message_templates');
  pgm.dropTable('wabas');
  pgm.dropTable('subscriptions');
  pgm.dropTable('clients');
};
