// server/src/utils/encryption.js became pluggable (GAP_FIX_PLAN.md Phase
// D1) — this locks in that the default backend's actual round-trip
// behavior is unchanged by the refactor (not just that it still parses),
// and that backend selection/error handling behaves as documented. Does
// NOT test the supabase_vault backend — that requires a real Supabase
// Vault instance (see secretStores/supabaseVaultStore.js's header), which
// nothing in local dev or this repo's CI can provide.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt } = require('../src/utils/encryption');

const ORIGINAL_SECRET_STORE = process.env.SECRET_STORE;

afterEach(() => {
  if (ORIGINAL_SECRET_STORE === undefined) delete process.env.SECRET_STORE;
  else process.env.SECRET_STORE = ORIGINAL_SECRET_STORE;
});

test('env backend: round-trips a value (SECRET_STORE unset, the default)', async () => {
  delete process.env.SECRET_STORE;
  const plain = 'EAAG_fake_meta_access_token_unset_default';
  const cipher = await encrypt(plain);
  assert.equal(await decrypt(cipher), plain);
});

test('env backend: round-trips a value (SECRET_STORE="env", explicit)', async () => {
  process.env.SECRET_STORE = 'env';
  const plain = 'EAAG_fake_meta_access_token_explicit_env';
  const cipher = await encrypt(plain);
  assert.equal(await decrypt(cipher), plain);
});

test('env backend: two encryptions of the same plaintext produce different ciphertext', async () => {
  process.env.SECRET_STORE = 'env';
  const plain = 'same-plaintext-both-times';
  const [a, b] = await Promise.all([encrypt(plain), encrypt(plain)]);
  assert.notEqual(a, b, 'a fresh random IV per call means ciphertext must differ even for identical plaintext');
});

test('unknown SECRET_STORE value throws clearly rather than silently falling back', async () => {
  process.env.SECRET_STORE = 'not_a_real_store';
  await assert.rejects(() => encrypt('anything'), /Unknown SECRET_STORE/);
});
