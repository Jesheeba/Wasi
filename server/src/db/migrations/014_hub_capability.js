// Hub capability (build plan Phase 5) — lets other Sirah applications (GV
// Mart, Sirah CRM, RD Interlocks, Fortune Innovatives) send/receive through
// Wasi's single Meta connection via a Wasi-issued, revocable API key,
// instead of each holding its own Meta token. Two new tenant-scoped tables
// (`api_keys`, `webhook_deliveries`) get the exact same treatment as every
// other tenant table since migration 013_tenant_isolation.js — RLS enabled
// and forced, granted to the restricted `wasi_app` role — even though (see
// server/src/middleware/requireApiKey.js's module comment) /api/v1/* always
// runs on the privileged connection today, the same documented exception
// wabas/admin/webhook/broadcastRunner already have. This is defense-in-depth
// for whatever routes through wasi_app in the future, not exercised today.
//
// api_keys.key_hash is SHA-256, not bcrypt — deliberately different from
// clients.password_hash. Bcrypt is for low-entropy human passwords and is
// slow and salted by design, which also makes it unusable for an indexed
// lookup-by-hash (every row would need a compare). A generated API key is
// already high-entropy, so a fast, deterministic hash that supports
// `where key_hash = $1` is the correct tool here — same reasoning
// authTokensRepo already uses for reset/verification tokens.
//
// webhook_deliveries is the durable retry queue behind BOTH forward
// targets: wabas.forward_to_url (a hub-connected consuming app) and the
// pre-existing client_webhooks table (a client's own self-configured
// integration webhook — see routes/metaWebhook.js's enqueueForwards).
// client_webhooks itself is untouched by this migration; only its delivery
// mechanism changed, from a fire-and-forget fetch with no retry to feeding
// this same queue. forward_secret on wabas is treated with the same care
// as wabas.access_token_encrypted (excluded from wasi_app's SELECT grant)
// since it lets whoever holds it forge signed deliveries to the consuming
// app.

exports.up = (pgm) => {
  pgm.createTable('api_keys', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    app_name: { type: 'text', notNull: true },
    key_hash: { type: 'text', notNull: true, unique: true },
    last_used_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('api_keys', 'client_id');

  pgm.addColumns('wabas', {
    forward_to_url: { type: 'text' },
    forward_secret: { type: 'text' },
  });

  // target_url/target_secret are snapshotted at enqueue time (not re-read
  // from wabas at delivery time) so a queued delivery is self-contained —
  // it survives forward_to_url changing or the wabas row disappearing
  // between enqueue and the runner's next tick.
  pgm.createTable('webhook_deliveries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    waba_id: { type: 'uuid', notNull: true, references: 'wabas', onDelete: 'CASCADE' },
    event: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    target_url: { type: 'text', notNull: true },
    target_secret: { type: 'text', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "status in ('pending', 'delivered', 'failed')",
    },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    next_attempt_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    delivered_at: { type: 'timestamptz' },
  });
  pgm.createIndex('webhook_deliveries', 'client_id');
  // Matches forwardRunner.js's claim query exactly: due, not-yet-delivered
  // rows ordered for FOR UPDATE SKIP LOCKED.
  pgm.createIndex('webhook_deliveries', ['status', 'next_attempt_at']);

  const NEW_TENANT_TABLES = ['api_keys', 'webhook_deliveries'];
  for (const table of NEW_TENANT_TABLES) {
    pgm.sql(`grant select, insert, update, delete on ${table} to wasi_app`);
  }

  pgm.sql(`grant select (forward_to_url), update (forward_to_url, forward_secret) on wabas to wasi_app`);
  pgm.sql(`revoke select (forward_secret) on wabas from wasi_app`);

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  for (const table of NEW_TENANT_TABLES) {
    pgm.sql(`alter table ${table} enable row level security`);
    pgm.sql(`alter table ${table} force row level security`);
    pgm.sql(`
      create policy tenant_isolation on ${table}
        using (client_id = ${setting})
        with check (client_id = ${setting})
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`drop policy if exists tenant_isolation on webhook_deliveries`);
  pgm.sql(`alter table webhook_deliveries disable row level security`);
  pgm.sql(`drop policy if exists tenant_isolation on api_keys`);
  pgm.sql(`alter table api_keys disable row level security`);

  pgm.sql(`revoke all on webhook_deliveries from wasi_app`);
  pgm.sql(`revoke all on api_keys from wasi_app`);
  pgm.sql(`revoke select (forward_to_url), update (forward_to_url, forward_secret) on wabas from wasi_app`);

  pgm.dropTable('webhook_deliveries');
  pgm.dropColumns('wabas', ['forward_to_url', 'forward_secret']);
  pgm.dropTable('api_keys');
};
