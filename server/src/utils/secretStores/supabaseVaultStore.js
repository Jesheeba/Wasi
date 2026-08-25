// Supabase Vault-backed secret storage — the real KMS/Vault upgrade path
// GAP_FIX_PLAN.md Phase D1 and ../encryption.js's original header comment
// both called for. UNVERIFIED against a real Supabase Vault instance as of
// this writing (2026-08-25) — built from Supabase's documented Vault SQL
// API, not exercised live. Before flipping SECRET_STORE=supabase_vault in
// any real environment, confirm against a real Supabase project:
//   1. Vault is enabled for the target project (Dashboard > Database >
//      Vault — an account/project-level setting, not something a
//      migration in this repo can turn on, and it does NOT exist on a
//      vanilla postgres:16-alpine instance, so local dev and this repo's
//      CI workflow cannot exercise this path today; that's exactly why
//      it's opt-in rather than the default).
//   2. The role this app connects as (see db/pool.js) can actually call
//      vault.create_secret / select from vault.decrypted_secrets — Vault's
//      functions are typically SECURITY DEFINER and available to the
//      `postgres` role by default on a Supabase project, but this has not
//      been confirmed against this app's actual connection role.
//   3. A real create -> decrypt round trip against that project, before
//      any real WABA token is ever written through this path.
//
// Stores the *value itself* via Vault's SQL API — what this app persists
// into wabas.access_token_encrypted under this backend is Vault's own
// secret id (a uuid returned by vault.create_secret), not a locally
// computed ciphertext blob the way envKeyStore.js produces. The column
// name is unchanged (still text, still fits a uuid string) — no migration
// needed to switch backends, only the cutover script below.
//
// Uses the privileged `pool` connection deliberately, not req.db: every
// existing call site that reaches this module already runs on `pool`,
// never the restricted `wasi_app` role — access_token_encrypted is
// revoked from wasi_app's SELECT grant (migration 013_tenant_isolation.js)
// — so this introduces no new permission surface versus envKeyStore.js.
const { pool } = require('../../db/pool');

async function encrypt(plainText) {
  const { rows } = await pool.query('select vault.create_secret($1) as id', [plainText]);
  return rows[0].id;
}

async function decrypt(secretId) {
  const { rows } = await pool.query(
    'select decrypted_secret from vault.decrypted_secrets where id = $1',
    [secretId]
  );
  if (!rows[0]) {
    throw new Error(
      `No Vault secret found for id "${secretId}". Either this value was encrypted under a ` +
      'different SECRET_STORE backend (see scripts/rotate-secret-store.js) or the secret was deleted from Vault directly.'
    );
  }
  return rows[0].decrypted_secret;
}

module.exports = { encrypt, decrypt };
