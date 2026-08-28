// Regression coverage for the admin-panel secret-masking work
// (wasi-mcp-server-plan.md-adjacent session note: this had NO prior test
// coverage at all — this file is the first). Directly triggered by a real
// leak found by inspection: POST /api/admin/clients/:id/retry-provisioning
// stripped access_token_encrypted but forgot forward_secret before
// responding, because it hand-rolled its own destructure instead of reusing
// maskWaba() (admin.js:27-30) like every other waba-returning route. Fixed
// by reusing maskWaba() there too — this file asserts that fix AND locks in
// every other maskWaba()/maskWebhook() call site so a third unmasked leak
// can't land unnoticed.
//
// Same dedicated-disposable-test-client pattern as apiV1.test.js. Only the
// outbound call to graph.facebook.com is faked (retry-provisioning calls
// metaClient.getPhoneNumberDetails for real otherwise).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const clientWebhooksRepo = require('../src/repositories/clientWebhooksRepo');
const { encrypt } = require('../src/utils/encryption');

let server;
let baseUrl;
let clientToken;
let testClientId;
let adminToken;

const SUITE_PREFIX = '__test_suite__adminsecretmasking_';
const FAKE_FORWARD_SECRET = 'fake_forward_secret_never_should_leave_this_process';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Whole-response-body string check, not just a field-by-field assertion —
// catches the secret leaking under a renamed key, nested somewhere
// unexpected, or via a future field addition, not just its documented spot.
function assertNoSecretInBody(bodyText, secret, label) {
  assert.ok(!bodyText.includes(secret), `${label}: response body must never contain the raw secret, but it does: ${bodyText}`);
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client`,
      email: `test-suite-adminsecretmasking-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: 'admin12345' }),
  }).then((r) => r.json());
  adminToken = adminLogin.token;
  assert.ok(adminToken, 'demo admin login must succeed — run `npm run db:seed` first');

  // A WABA with BOTH secrets set — access_token_encrypted (always masked)
  // and forward_secret (the one that leaked) — so any route that forgets
  // to mask either one is caught.
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: `${SUITE_PREFIX}waba`,
    phone_number_id: `${SUITE_PREFIX}phone`,
    status: 'connected',
    access_token_encrypted: encrypt('fake-meta-access-token-never-sent-anywhere'),
    forward_to_url: 'https://example.com/hub-forward-webhook',
    forward_secret: FAKE_FORWARD_SECRET,
    forward_events: ['message.received'],
  });
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('THE BUG, FIXED: retry-provisioning never returns forward_secret (or access_token_encrypted) in plaintext', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    return {
      ok: true,
      status: 200,
      json: async () => ({ verified_name: 'Masking Test Business', quality_rating: 'GREEN' }),
    };
  };

  let res, bodyText;
  try {
    res = await fetch(`${baseUrl}/api/admin/clients/${testClientId}/retry-provisioning`, {
      method: 'POST',
      headers: authed(adminToken),
    });
    bodyText = await res.text();
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(res.status, 200, bodyText);
  assertNoSecretInBody(bodyText, FAKE_FORWARD_SECRET, 'retry-provisioning');
  assertNoSecretInBody(bodyText, 'fake-meta-access-token-never-sent-anywhere', 'retry-provisioning');

  // Not just "the secret is absent" — confirm maskWaba() actually ran
  // (rather than, say, some other code path that happens to omit it too),
  // by checking its documented masked-shape fields are present.
  const body = JSON.parse(bodyText);
  assert.equal(body.waba.has_forward_secret, true);
  assert.equal(body.waba.forward_secret_last4, FAKE_FORWARD_SECRET.slice(-4));
  assert.equal('forward_secret' in body.waba, false);
  assert.equal('access_token_encrypted' in body.waba, false);
  assert.equal(body.waba.quality_rating, 'GREEN');
});

test('GET /api/admin/wabas: no forward_secret/access_token_encrypted for any client in the list', async () => {
  const res = await fetch(`${baseUrl}/api/admin/wabas`, { headers: authed(adminToken) });
  const bodyText = await res.text();
  assert.equal(res.status, 200);
  assertNoSecretInBody(bodyText, FAKE_FORWARD_SECRET, 'GET /wabas');
});

test('GET /api/admin/clients/:id: no forward_secret/access_token_encrypted in client detail', async () => {
  const res = await fetch(`${baseUrl}/api/admin/clients/${testClientId}`, { headers: authed(adminToken) });
  const bodyText = await res.text();
  assert.equal(res.status, 200);
  assertNoSecretInBody(bodyText, FAKE_FORWARD_SECRET, 'GET /clients/:id');
});

test('POST /clients/:id/hub-forward: saving over an EXISTING secret does not re-expose it', async () => {
  const res = await fetch(`${baseUrl}/api/admin/clients/${testClientId}/hub-forward`, {
    method: 'POST',
    headers: authed(adminToken),
    body: JSON.stringify({ forward_to_url: 'https://example.com/hub-forward-webhook-updated', events: ['message.received'] }),
  });
  const bodyText = await res.text();
  assert.equal(res.status, 200, bodyText);
  assertNoSecretInBody(bodyText, FAKE_FORWARD_SECRET, 'hub-forward (existing secret)');
  const body = JSON.parse(bodyText);
  assert.equal(body.has_forward_secret, true);
});

test('POST /clients/:id/hub-forward/regenerate-secret: DOES return the new raw secret once (intended, positive case)', async () => {
  const res = await fetch(`${baseUrl}/api/admin/clients/${testClientId}/hub-forward/regenerate-secret`, {
    method: 'POST',
    headers: authed(adminToken),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.forward_secret, 'regenerate-secret must return the new raw secret exactly once');
  assert.notEqual(body.forward_secret, FAKE_FORWARD_SECRET, 'must be a genuinely new secret, not the old one');
});

test('GET /api/client-webhook (clientWebhook.js): no raw secret leaked to the owning client either', async () => {
  await clientWebhooksRepo.upsert(pool, testClientId, 'https://example.com/client-webhook', 'fake_client_webhook_secret_xyz', ['message.received']);
  const res = await fetch(`${baseUrl}/api/client-webhook`, { headers: authed(clientToken) });
  const bodyText = await res.text();
  assert.equal(res.status, 200);
  assertNoSecretInBody(bodyText, 'fake_client_webhook_secret_xyz', 'GET /api/client-webhook');
  const body = JSON.parse(bodyText);
  assert.equal(body.has_secret, true);
});

// A different table than the waba/webhook secrets above — api_keys.key_hash
// (the SHA-256 lookup value requireApiKey.js hashes an incoming bearer key
// against, not a reversible secret, but internal and never meant to leave
// this process). apiKeysRepo.create/revoke both `returning *`, so both
// routes previously spread key_hash straight into their response alongside
// the intentional raw `key`/`revoked_at` fields. Field-presence checks, not
// a body-string search, since the hash value is generated per-call and not
// known ahead of time the way the fixed forward_secret fixtures above are.
test('POST /api/admin/api-keys: response never includes key_hash', async () => {
  const res = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST',
    headers: authed(adminToken),
    body: JSON.stringify({ client_id: testClientId, app_name: `${SUITE_PREFIX}key_hash_check` }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal('key_hash' in body, false);
  assert.ok(body.key, 'the raw key itself must still be returned — that part is intentional');
});

test('POST /api/admin/api-keys/:id/revoke: response never includes key_hash', async () => {
  const created = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST',
    headers: authed(adminToken),
    body: JSON.stringify({ client_id: testClientId, app_name: `${SUITE_PREFIX}key_hash_check_revoke` }),
  }).then((r) => r.json());

  const res = await fetch(`${baseUrl}/api/admin/api-keys/${created.id}/revoke`, {
    method: 'POST',
    headers: authed(adminToken),
    body: JSON.stringify({ client_id: testClientId }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal('key_hash' in body, false);
  assert.ok(body.revoked_at, 'the revoke confirmation itself must still come through — that part is intentional');
});
