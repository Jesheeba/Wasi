// Instagram DM Automation, Phase 1 — parallel connection table for Instagram
// Business accounts (linked via a Facebook Page), deliberately NOT an
// extension of `wabas`. Mirrors wabas' connection-state shape
// (status/connect_diagnostics/access_token_encrypted/verified_at) but drops
// every WhatsApp Cloud API-only concept that has no Instagram Messaging API
// analog: phone_number_id, quality_rating, messaging_tier, phone
// registration/sendability columns, message templates.
//
// access_token_encrypted holds the Page's own access token (Instagram DM
// send/receive authenticates via the linked Page, not a separate IG-account
// token) — same AES-256-GCM encrypt()/decrypt() as wabas.access_token_encrypted
// (server/src/utils/encryption.js).
//
// Same privileged-pool-only treatment as wabas (see wabasRepo.js's own module
// comment): wasi_app is deliberately NOT granted access to this table at all
// — every read/write stays on the privileged `pool` connection. RLS is still
// enabled+forced as a backstop, same reasoning as migration 013's treatment
// of wabas.
exports.up = (pgm) => {
  pgm.createTable('instagram_accounts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    page_id: { type: 'text', unique: true },
    instagram_business_account_id: { type: 'text' },
    ig_username: { type: 'text' },
    access_token_encrypted: { type: 'text' },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      // Mirrors wabas' own connection-state vocabulary (no CHECK constraint
      // there either — kept consistent, not tightened, for this first table).
    },
    connect_diagnostics: { type: 'jsonb' },
    verified_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('instagram_accounts', 'client_id');

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql(`alter table instagram_accounts enable row level security`);
  pgm.sql(`alter table instagram_accounts force row level security`);
  pgm.sql(`
    create policy tenant_isolation on instagram_accounts
      using (client_id = ${setting})
      with check (client_id = ${setting})
  `);
};

exports.down = async (pgm) => {
  // Same live-row guard discipline as migration 057/055's down()s — a real
  // client's Instagram connection attempt (even a failed one, worth keeping
  // for support/audit) should never be silently dropped by a rollback on this
  // shared database.
  const [{ count }] = await pgm.db.select('select count(*)::int as count from instagram_accounts');
  if (count > 0) {
    throw new Error(
      `Cannot roll back 081_instagram_accounts: ${count} real row(s) exist. ` +
      `Export/back up first if they need to be kept, then retry this rollback.`
    );
  }

  pgm.sql(`drop policy if exists tenant_isolation on instagram_accounts`);
  pgm.sql(`alter table instagram_accounts disable row level security`);
  pgm.dropTable('instagram_accounts');
};
