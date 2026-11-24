// Ad account connection for Click-to-WhatsApp spend/clicks/cost per lead
// (build-docs/features/ctwa-ad-metrics.md).
//
// ads_connections: one per client. The client signs in with Facebook (Login
// for Business, ads_read) and picks the ad account behind their
// Click-to-WhatsApp ads. The access token is stored encrypted with
// utils/encryption.js and never returned to the browser. Tenant table:
// wasi_app grant + RLS (same as 039/095/096/097/099).
exports.up = (pgm) => {
  pgm.createTable('ads_connections', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, unique: true, references: 'clients', onDelete: 'CASCADE' },
    access_token_encrypted: { type: 'text', notNull: true },
    token_expires_at: { type: 'timestamptz' },
    ad_account_id: { type: 'text' },
    ad_account_name: { type: 'text' },
    currency: { type: 'text' },
    last_error: { type: 'text' },
    connected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql('grant select, insert, update, delete on ads_connections to wasi_app');
  pgm.sql('alter table ads_connections enable row level security');
  pgm.sql('alter table ads_connections force row level security');
  pgm.sql(`create policy tenant_isolation on ads_connections using (client_id = ${setting}) with check (client_id = ${setting})`);
};

// Only a connection; the client can reconnect. Ads data stays at Meta.
exports.down = (pgm) => {
  pgm.dropTable('ads_connections');
};
