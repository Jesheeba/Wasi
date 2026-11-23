// WooCommerce integration (build-docs/features/woocommerce-integration.md).
//
// ecommerce_stores: one connected store per client (platform kept as a
// column so Shopify can reuse the table later). REST keys and the webhook
// secret are encrypted with utils/encryption.js, never stored in plain text.
// connect_token is the one-click flow's state (sent to WooCommerce as
// user_id, matched when the store POSTs the keys back).
//
// ecommerce_message_rules: which approved template each order trigger
// sends, and how its variables map to order fields.
//
// ecommerce_events: one row per handled order event, for the activity list
// and for dedupe (store_id, dedupe_key). Holds only the order fields used,
// never the whole order payload.
//
// All three are tenant tables: wasi_app grant + RLS (same as 039/095). The
// public webhook handler writes on the privileged pool and scopes by
// client_id explicitly.
exports.up = (pgm) => {
  pgm.createTable('ecommerce_stores', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    platform: { type: 'text', notNull: true, default: 'woocommerce', check: "platform in ('woocommerce')" },
    store_url: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending', check: "status in ('pending', 'connected', 'error')" },
    consumer_key_encrypted: { type: 'text' },
    consumer_secret_encrypted: { type: 'text' },
    webhook_secret_encrypted: { type: 'text' },
    connect_token: { type: 'text' },
    webhook_ids: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    last_event_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('ecommerce_stores', ['client_id', 'platform'], { unique: true });
  pgm.createIndex('ecommerce_stores', 'connect_token', { unique: true, where: 'connect_token is not null' });

  pgm.createTable('ecommerce_message_rules', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    store_id: { type: 'uuid', notNull: true, references: 'ecommerce_stores', onDelete: 'CASCADE' },
    trigger: { type: 'text', notNull: true },
    template_name: { type: 'text', notNull: true },
    param_map: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    enabled: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('ecommerce_message_rules', ['store_id', 'trigger'], { unique: true });

  pgm.createTable('ecommerce_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    store_id: { type: 'uuid', notNull: true, references: 'ecommerce_stores', onDelete: 'CASCADE' },
    trigger: { type: 'text', notNull: true },
    dedupe_key: { type: 'text', notNull: true },
    order_number: { type: 'text' },
    customer_name: { type: 'text' },
    phone: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'received', check: "status in ('received', 'sent', 'skipped', 'no_rule', 'failed')" },
    detail: { type: 'text' },
    message_id: { type: 'uuid', references: 'messages', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('ecommerce_events', ['store_id', 'dedupe_key'], { unique: true });
  pgm.createIndex('ecommerce_events', ['client_id', 'created_at']);

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  for (const table of ['ecommerce_stores', 'ecommerce_message_rules', 'ecommerce_events']) {
    pgm.sql(`grant select, insert, update, delete on ${table} to wasi_app`);
    pgm.sql(`alter table ${table} enable row level security`);
    pgm.sql(`alter table ${table} force row level security`);
    pgm.sql(`create policy tenant_isolation on ${table} using (client_id = ${setting}) with check (client_id = ${setting})`);
  }
};

// Real connected stores (with their keys) could exist by the time this runs:
// refuse with the count instead of dropping them.
exports.down = async (pgm) => {
  const [{ count }] = await pgm.db.select('select count(*)::int as count from ecommerce_stores');
  if (count > 0) {
    throw new Error(`Cannot roll back 096_ecommerce_woocommerce: ${count} connected store(s) exist. Disconnect them first.`);
  }
  pgm.dropTable('ecommerce_events');
  pgm.dropTable('ecommerce_message_rules');
  pgm.dropTable('ecommerce_stores');
};
