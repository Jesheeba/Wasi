// PLAN.md item 25 — server-side WABA/phone discovery, the needs_manual_
// resolution state, and the "Meta linked it, we never got the code" state.
// Same dedicated-disposable-client pattern as api.test.js (never the demo
// client — see that file's own comment for why). metaClient is stubbed the
// same way api.test.js's coexistence test already does; never a real Meta
// call.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const metaClient = require('../src/utils/metaClient');

let server;
let baseUrl;
let clientToken;
let testClientId;
let adminToken;

const original = {};
function stubMetaClient(overrides) {
  for (const key of Object.keys(overrides)) {
    if (!(key in original)) original[key] = metaClient[key];
    metaClient[key] = overrides[key];
  }
}
function restoreMetaClient() {
  Object.assign(metaClient, original);
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
      businessName: '__test_suite__discovery_client',
      email: `test-suite-discovery-${Date.now()}@wasi.local`,
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
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(() => {
  restoreMetaClient();
  // Base stubs every test in this file needs — individual tests override
  // debugToken/listPhoneNumbers as their scenario requires.
  stubMetaClient({
    exchangeCodeForToken: async () => 'short-lived-fake',
    exchangeForLongLivedToken: async () => 'long-lived-fake',
    subscribeAppToWaba: async () => ({}),
    registerPhoneNumber: async () => ({}),
    getPhoneNumberDetails: async () => ({ verified_name: 'Test Business', display_phone_number: '+1 555 0100', quality_rating: 'GREEN' }),
  });
});

function authed(token) {
  return { Authorization: `Bearer ${token}` };
}

test('discovery: resolves a single WABA and phone number when the popup supplied neither', async () => {
  stubMetaClient({
    debugToken: async () => ({ granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['999888777'] }] }),
    listPhoneNumbers: async () => [{ id: '111222333', display_phone_number: '+1 555 0100' }],
  });

  const res = await fetch(`${baseUrl}/api/onboarding/whatsapp/connect`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'fake' }), // no waba_id/phone_number_id at all
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.connected, true);

  const { rows } = await pool.query('select waba_id, phone_number_id, status from wabas where client_id = $1', [testClientId]);
  assert.equal(rows[0].waba_id, '999888777');
  assert.equal(rows[0].phone_number_id, '111222333');
  assert.equal(rows[0].status, 'connected');
});

test('discovery: multiple WABAs records needs_manual_resolution, does not guess', async () => {
  stubMetaClient({
    debugToken: async () => ({ granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['waba-A', 'waba-B'] }] }),
  });

  const res = await fetch(`${baseUrl}/api/onboarding/whatsapp/connect`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'fake' }),
  });
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, 'needs_manual_resolution');

  const { rows } = await pool.query('select status, connect_diagnostics from wabas where client_id = $1', [testClientId]);
  assert.equal(rows[0].status, 'needs_manual_resolution');
  assert.equal(rows[0].connect_diagnostics.reason, 'multiple_wabas');
  assert.deepEqual(rows[0].connect_diagnostics.wabaTargetIds, ['waba-A', 'waba-B']);

  const { rows: audit } = await pool.query(
    `select action from audit_log where actor_id = $1 and action = 'whatsapp_connect_needs_manual_resolution'`,
    [testClientId]
  );
  assert.equal(audit.length, 1, 'the ambiguity must be audited, not just recorded silently');
});

test('discovery: a transient debug_token failure falls back to the existing audited failure path, not a crash', async () => {
  stubMetaClient({
    debugToken: async () => { throw new Error('simulated transient Meta error'); },
  });

  const res = await fetch(`${baseUrl}/api/onboarding/whatsapp/connect`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'fake' }),
  });
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.match(data.detail, /never sent a WhatsApp Business Account/);

  const { rows } = await pool.query(
    `select action from audit_log where actor_id = $1 and action = 'whatsapp_connect_failed' order by created_at desc limit 1`,
    [testClientId]
  );
  assert.equal(rows.length, 1);
});

test('connect-incomplete: records the "Meta linked it, we never got the code" state', async () => {
  const res = await fetch(`${baseUrl}/api/onboarding/whatsapp/connect-incomplete`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ waba_id: 'incomplete-waba-id' }),
  });
  assert.equal(res.status, 200);

  const { rows } = await pool.query('select waba_id, status from wabas where client_id = $1', [testClientId]);
  assert.equal(rows[0].waba_id, 'incomplete-waba-id');
  assert.equal(rows[0].status, 'incomplete_meta_linked');

  const { rows: audit } = await pool.query(
    `select action from audit_log where actor_id = $1 and action = 'whatsapp_connect_incomplete'`,
    [testClientId]
  );
  assert.equal(audit.length, 1);

  // admin's retry-provisioning must give a distinct, honest message for this
  // state, not the generic "no connection to retry" — different meaning.
  const retryRes = await fetch(`${baseUrl}/api/admin/clients/${testClientId}/retry-provisioning`, {
    method: 'POST',
    headers: authed(adminToken),
  });
  assert.equal(retryRes.status, 400);
  const retryData = await retryRes.json();
  assert.match(retryData.error, /never handed back an authorization code/);
});

test('admin resolve-waba: completes a needs_manual_resolution connection using the stored token', async () => {
  stubMetaClient({
    debugToken: async () => ({ granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['waba-X', 'waba-Y'] }] }),
  });
  const connectRes = await fetch(`${baseUrl}/api/onboarding/whatsapp/connect`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'fake' }),
  });
  assert.equal(connectRes.status, 409);

  // Admin picks waba-X; it has exactly one phone number, so this completes
  // in one round-trip.
  stubMetaClient({
    listPhoneNumbers: async () => [{ id: 'phone-X', display_phone_number: '+1 555 0199' }],
  });
  const resolveRes = await fetch(`${baseUrl}/api/admin/clients/${testClientId}/resolve-waba`, {
    method: 'POST',
    headers: { ...authed(adminToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ wabaId: 'waba-X' }),
  });
  assert.equal(resolveRes.status, 200);
  const resolveData = await resolveRes.json();
  assert.equal(resolveData.resolved, true);
  assert.equal(resolveData.waba.waba_id, 'waba-X');
  assert.equal(resolveData.waba.phone_number_id, 'phone-X');
  assert.equal(resolveData.waba.status, 'connected');
  assert.equal(resolveData.waba.access_token_encrypted, undefined, 'maskWaba must still strip the token from the admin response');

  const { rows: audit } = await pool.query(
    `select action from audit_log where target like $1 and action = 'whatsapp_resolve_waba'`,
    [`${testClientId}%`]
  );
  assert.equal(audit.length, 1);
});
