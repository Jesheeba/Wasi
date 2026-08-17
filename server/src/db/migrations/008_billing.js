// Billing lifecycle: real invoice history (previously nothing persisted
// beyond an audit-log line), plan pricing/limits as data instead of a
// hardcoded object duplicated in billing.js and admin.js, and a renewal
// checkpoint subscriptions.renews_at can actually be checked against (it
// existed as a column before this but nothing ever wrote to it).

exports.up = (pgm) => {
  pgm.createTable('plans', {
    id: { type: 'text', primaryKey: true }, // 'Starter' | 'Growth' | 'Scale' — matches subscriptions.plan values already in use
    price_inr: { type: 'integer', notNull: true },
    conversation_limit: { type: 'integer' }, // null = unlimited (Scale)
  });
  pgm.sql(`
    insert into plans (id, price_inr, conversation_limit) values
      ('Starter', 999, 500),
      ('Growth', 2999, 3000),
      ('Scale', 7999, null)
  `);

  pgm.createTable('invoices', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    subscription_id: { type: 'uuid', references: 'subscriptions', onDelete: 'SET NULL' },
    plan: { type: 'text', notNull: true },
    amount_inr: { type: 'integer', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'created',
      check: "status in ('created','paid','failed','refunded')",
    },
    razorpay_order_id: { type: 'text' },
    razorpay_payment_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('invoices', 'client_id');
  pgm.createIndex('invoices', 'razorpay_order_id');
};

exports.down = (pgm) => {
  pgm.dropTable('invoices');
  pgm.dropTable('plans');
};
