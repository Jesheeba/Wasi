// Pluggable secret storage for wabas.access_token_encrypted — dispatches
// to a concrete backend by SECRET_STORE (env var). Default ('env', or
// unset) is envKeyStore.js, the original MVP AES-256-GCM-keyed-by-
// SERVER_SECRET implementation — unchanged behavior for anyone who hasn't
// opted in to the new backend. 'supabase_vault' (supabaseVaultStore.js) is
// the real KMS/Vault upgrade GAP_FIX_PLAN.md Phase D1 called for; see that
// file's header for its unverified-against-a-real-Vault caveats before
// relying on it.
//
// Both encrypt/decrypt are async regardless of which backend is active —
// envKeyStore's crypto calls are synchronous internally, but Vault's
// aren't (a real DB round trip), so the public interface here is async
// either way rather than making every one of this codebase's ~11 call
// sites branch on which backend is active.
//
// IMPORTANT: switching SECRET_STORE on a database that already has tokens
// encrypted under the OTHER backend breaks decryption for every existing
// row — this module does NOT try both backends or auto-detect which one
// produced a given stored value. A real cutover needs every existing
// wabas.access_token_encrypted value re-encrypted under the new backend
// first; see scripts/rotate-secret-store.js.
const envKeyStore = require('./secretStores/envKeyStore');
const supabaseVaultStore = require('./secretStores/supabaseVaultStore');

const STORES = { env: envKeyStore, supabase_vault: supabaseVaultStore };

function currentStore() {
  const which = process.env.SECRET_STORE || 'env';
  const store = STORES[which];
  if (!store) throw new Error(`Unknown SECRET_STORE "${which}" — expected one of: ${Object.keys(STORES).join(', ')}.`);
  return store;
}

async function encrypt(plainText) {
  return currentStore().encrypt(plainText);
}

async function decrypt(payload) {
  return currentStore().decrypt(payload);
}

module.exports = { encrypt, decrypt };
