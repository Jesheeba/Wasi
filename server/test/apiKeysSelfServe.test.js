// Client self-serve API key revoke/delete (routes/apiKeys.js) — reverses
// admin.js's original "consuming apps don't self-serve keys" comment for
// revoke/delete only; issuing a new key stays admin-only (no POST / here).
// Same dedicated-disposable-test-client pattern as apiV1.test.js.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;
let clientToken;
let testClientId;
let adminToken;
let otherClientToken;
let otherClientId;

const SUITE_PREFIX = '__test_suite__apikeysselfserve_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function registerClient(suffix) {
  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client_${suffix}`,
      email: `test-suite-apikeysselfserve-${suffix}-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  return { token: registered.token, id: registered.client?.id };
}

async function issueKey(clientId, appName) {
  return fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST',
    headers: authed(adminToken),
    body: JSON.stringify({ client_id: clientId, app_name: appName }),
  }).then((r) => r.json());
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const primary = await registerClient('primary');
  clientToken = primary.token;
  testClientId = primary.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  const other = await registerClient('other');
  otherClientToken = other.token;
  otherClientId = other.id;

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
  if (otherClientId) await pool.query('delete from clients where id = $1', [otherClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('GET /api/api-keys lists only the caller\'s own keys, never key_hash', async () => {
  await issueKey(testClientId, `${SUITE_PREFIX}app_list`);
  const res = await fetch(`${baseUrl}/api/api-keys`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const keys = await res.json();
  assert.ok(keys.length >= 1);
  assert.ok(keys.every((k) => !('key_hash' in k)));
});

test('a client cannot revoke or delete another client\'s key', async () => {
  const issued = await issueKey(otherClientId, `${SUITE_PREFIX}app_foreign`);

  const revokeRes = await fetch(`${baseUrl}/api/api-keys/${issued.id}/revoke`, {
    method: 'POST',
    headers: authed(clientToken),
  });
  assert.equal(revokeRes.status, 404);

  const deleteRes = await fetch(`${baseUrl}/api/api-keys/${issued.id}`, {
    method: 'DELETE',
    headers: authed(clientToken),
  });
  assert.equal(deleteRes.status, 404);
});

test('revoking/deleting the client\'s ONLY active key is blocked with 409 and an explanatory message', async () => {
  // testClientId already has an active key from the "lists only" test above
  // (single-key state at this point in the suite) — revoke it via admin
  // first isn't needed; just fetch current keys and confirm exactly one is active.
  const keys = await fetch(`${baseUrl}/api/api-keys`, { headers: authed(clientToken) }).then((r) => r.json());
  const active = keys.filter((k) => !k.revoked_at);
  assert.equal(active.length, 1, 'test setup assumption: exactly one active key before this test');
  const onlyKey = active[0];

  const revokeRes = await fetch(`${baseUrl}/api/api-keys/${onlyKey.id}/revoke`, {
    method: 'POST',
    headers: authed(clientToken),
  });
  assert.equal(revokeRes.status, 409);
  const revokeData = await revokeRes.json();
  assert.equal(revokeData.code, 'last_active_key');
  assert.match(revokeData.error, /only active/i);
  assert.match(revokeData.hint, /support/i);

  const deleteRes = await fetch(`${baseUrl}/api/api-keys/${onlyKey.id}`, {
    method: 'DELETE',
    headers: authed(clientToken),
  });
  assert.equal(deleteRes.status, 409);
});

test('with a second key issued, the client can now revoke the first without being blocked', async () => {
  const second = await issueKey(testClientId, `${SUITE_PREFIX}app_second`);
  const keysBefore = await fetch(`${baseUrl}/api/api-keys`, { headers: authed(clientToken) }).then((r) => r.json());
  const firstActive = keysBefore.find((k) => !k.revoked_at && k.id !== second.id);
  assert.ok(firstActive, 'expected the original key to still be active alongside the new second one');

  const revokeRes = await fetch(`${baseUrl}/api/api-keys/${firstActive.id}/revoke`, {
    method: 'POST',
    headers: authed(clientToken),
  });
  assert.equal(revokeRes.status, 200);
  const revoked = await revokeRes.json();
  assert.ok(revoked.revoked_at);
});

test('deleting an already-revoked key is allowed even if it\'s the client\'s last row (no active-key impact)', async () => {
  // At this point testClientId has: firstActive (revoked above) and `second` (active).
  // Revoking `second` too would hit the last-active-key guard, so instead
  // delete the already-revoked firstActive — that should succeed freely.
  const keys = await fetch(`${baseUrl}/api/api-keys`, { headers: authed(clientToken) }).then((r) => r.json());
  const revokedOne = keys.find((k) => k.revoked_at);
  assert.ok(revokedOne, 'expected a previously-revoked key from the prior test');

  const deleteRes = await fetch(`${baseUrl}/api/api-keys/${revokedOne.id}`, {
    method: 'DELETE',
    headers: authed(clientToken),
  });
  assert.equal(deleteRes.status, 200);

  const afterDelete = await fetch(`${baseUrl}/api/api-keys`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.ok(afterDelete.every((k) => k.id !== revokedOne.id), 'soft-deleted key must drop out of the list');
});

test('unauthenticated requests to /api/api-keys are rejected', async () => {
  const res = await fetch(`${baseUrl}/api/api-keys`);
  assert.equal(res.status, 401);
});
