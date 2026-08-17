// Backs the five Settings/Payments/Wallet screens that were previously
// client-side-only (a modal submit just appended a DOM row — nothing
// persisted past a page refresh): Team, Attributes, Payment Links, Wallet,
// Webhook callback config.

exports.up = (pgm) => {
  pgm.createTable('team_members', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    email: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true, default: 'Agent' },
    status: { type: 'text', notNull: true, default: 'invited', check: "status in ('invited', 'active')" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('team_members', 'team_members_client_email_unique', { unique: ['client_id', 'email'] });
  pgm.createIndex('team_members', 'client_id');

  pgm.createTable('contact_attributes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    type: { type: 'text', notNull: true, default: 'text', check: "type in ('text', 'number', 'date', 'boolean')" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('contact_attributes', 'contact_attributes_client_name_unique', { unique: ['client_id', 'name'] });
  pgm.createIndex('contact_attributes', 'client_id');

  pgm.createTable('payment_links', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true },
    amount_inr: { type: 'integer', notNull: true },
    status: { type: 'text', notNull: true, default: 'created', check: "status in ('created', 'paid', 'expired', 'cancelled')" },
    razorpay_payment_link_id: { type: 'text' },
    url: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('payment_links', 'client_id');
  pgm.createIndex('payment_links', 'razorpay_payment_link_id');

  pgm.createTable('wallet_transactions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    amount_inr: { type: 'integer', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending', check: "status in ('pending', 'completed', 'failed')" },
    razorpay_order_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('wallet_transactions', 'client_id');
  pgm.createIndex('wallet_transactions', 'razorpay_order_id');

  pgm.createTable('client_webhooks', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    callback_url: { type: 'text', notNull: true },
    secret: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('client_webhooks', 'client_webhooks_client_unique', { unique: ['client_id'] });
};

exports.down = (pgm) => {
  pgm.dropTable('client_webhooks');
  pgm.dropTable('wallet_transactions');
  pgm.dropTable('payment_links');
  pgm.dropTable('contact_attributes');
  pgm.dropTable('team_members');
};
