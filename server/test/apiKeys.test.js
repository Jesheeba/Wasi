// Client-authenticated self-service API key routes (GAP_FIX_PLAN.md Phase
// C2, server/src/routes/apiKeys.js) — mirrors api.test.js's pattern
// (real app boot, real HTTP, a dedicated disposable test client rather
// than the demo client) for the same reason: a fresh client has no WABA
// and no contacts, so nothing here can reach a real phone or a real Meta
// call. Also confirms the RLS tenant_isolation policy on api_keys
// (migration 014_hub_capability.js — enabled since that migration, but
// until this route existed had no real caller going through the
// restricted wasi_app role to exercise it) actually scopes a client's own
// key list to itself, not to every client's keys.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;
let clientToken;
let testClientId;
let otherClientToken;
let otherClientId;

const SUITE_PREFIX = '__test_suite__apiKeys_';

async function registerClient(suffix) {
  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}${suffix}`,
      email: `test-suite-apikeys-${suffix}-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  assert.ok(registered.token && registered.client?.id, `dedicated test client (${suffix}) registration must succeed`);
  return { token: registered.token, id: registered.client.id };
}

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  ({ token: clientToken, id: testClientId } = await registerClient('a'));
  ({ token: otherClientToken, id: otherClientId } = await registerClient('b'));
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  if (otherClientId) await pool.query('delete from clients where id = $1', [otherClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('unauthenticated request is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/api-keys`);
  assert.equal(res.status, 401);
});

test('generate: returns the raw key once, never again in list', async () => {
  const created = await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ app_name: `${SUITE_PREFIX}App` }),
  }).then((r) => r.json());
  assert.equal(created.app_name, `${SUITE_PREFIX}App`);
  assert.ok(created.key?.startsWith('wasi_'), 'response includes the raw key, shown once');

  const list = await fetch(`${baseUrl}/api/api-keys`, { headers: authed(clientToken) }).then((r) => r.json());
  const listed = list.find((k) => k.id === created.id);
  assert.ok(listed, 'the created key appears in this client\'s own list');
  assert.equal(listed.key, undefined, 'the raw key is never returned again from the list endpoint');
});

test('generate: rejects an empty app_name', async () => {
  const res = await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ app_name: '' }),
  });
  assert.equal(res.status, 400);
});

test('tenant isolation: one client cannot see another client\'s keys', async () => {
  await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: authed(otherClientToken),
    body: JSON.stringify({ app_name: `${SUITE_PREFIX}OtherClientApp` }),
  });

  const list = await fetch(`${baseUrl}/api/api-keys`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.ok(!list.some((k) => k.app_name === `${SUITE_PREFIX}OtherClientApp`), 'RLS must scope the list to the caller\'s own client_id');
});

test('revoke: key stops working for the Hub API and shows revoked in the list', async () => {
  const created = await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ app_name: `${SUITE_PREFIX}RevokeMe` }),
  }).then((r) => r.json());

  const hubCheck = await fetch(`${baseUrl}/api/v1/templates`, { headers: { Authorization: `Bearer ${created.key}` } });
  assert.equal(hubCheck.status, 200, 'the freshly generated key must actually authenticate against the Hub API');

  const revokeRes = await fetch(`${baseUrl}/api/api-keys/${created.id}`, {
    method: 'DELETE',
    headers: authed(clientToken),
  });
  assert.equal(revokeRes.status, 200);

  const hubCheckAfterRevoke = await fetch(`${baseUrl}/api/v1/templates`, { headers: { Authorization: `Bearer ${created.key}` } });
  assert.equal(hubCheckAfterRevoke.status, 401, 'a revoked key must no longer authenticate');

  const list = await fetch(`${baseUrl}/api/api-keys`, { headers: authed(clientToken) }).then((r) => r.json());
  const listed = list.find((k) => k.id === created.id);
  assert.ok(listed.revoked_at, 'revoked key shows a revoked_at timestamp in the list');
});

test('revoke: cannot revoke another client\'s key', async () => {
  const created = await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: authed(otherClientToken),
    body: JSON.stringify({ app_name: `${SUITE_PREFIX}NotYours` }),
  }).then((r) => r.json());

  const res = await fetch(`${baseUrl}/api/api-keys/${created.id}`, {
    method: 'DELETE',
    headers: authed(clientToken),
  });
  assert.equal(res.status, 404, 'revoking a key that belongs to a different client must not succeed');
});
