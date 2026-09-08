// PLAN.md item 4 — canned responses (/slash commands). Verifies:
// 1. Create/list round trip, scoped to the caller's own client.
// 2. GET reachable by Admin/Manager/Agent; POST/DELETE Admin/Manager only.
// 3. Duplicate shortcut within a client is rejected (409, real DB
//    constraint — canned_responses_client_shortcut_unique).
// 4. Tenant isolation: another client's canned responses are invisible.
// Same dedicated-disposable-test-client convention as every other file in
// this directory.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const authTokensRepo = require('../src/repositories/authTokensRepo');

let server;
let baseUrl;
let clientToken;
let testClientId;
let otherClientToken;
let otherClientId;

const SUITE_PREFIX = '__test_suite__cannedresponses_';
const PASSWORD = 'test-suite-password-12345';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function registerClient(suffix) {
  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client_${suffix}`,
      email: `test-suite-cannedresponses-${suffix}-${Date.now()}@wasi.local`,
      password: PASSWORD,
    }),
  }).then((r) => r.json());
  return { token: registered.token, id: registered.client?.id };
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
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  if (otherClientId) await pool.query('delete from clients where id = $1', [otherClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function createTeamMemberJwt(role) {
  const created = await fetch(`${baseUrl}/api/team-members`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}${role}`, email: `${SUITE_PREFIX}${role}-${Date.now()}@wasi.local`, role }),
  }).then((r) => r.json());

  const token = await authTokensRepo.create('team_member', created.id, 'team_invite', 60);
  const accepted = await fetch(`${baseUrl}/api/auth/team/accept-invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password: PASSWORD }),
  }).then((r) => r.json());
  return { id: created.id, jwt: accepted.token };
}

test('1. create then list round trip', async () => {
  const createRes = await fetch(`${baseUrl}/api/canned-responses`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ shortcut: `${SUITE_PREFIX}/refund`, body: 'Your refund has been processed.' }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.shortcut, `${SUITE_PREFIX}/refund`);
  assert.equal(created.body, 'Your refund has been processed.');

  const listRes = await fetch(`${baseUrl}/api/canned-responses`, { headers: authed(clientToken) });
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.ok(list.some((c) => c.id === created.id));
});

test('2. GET is reachable by Admin/Manager/Agent; POST and DELETE are Admin/Manager only', async () => {
  const created = await fetch(`${baseUrl}/api/canned-responses`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ shortcut: `${SUITE_PREFIX}/hello`, body: 'Hi there!' }),
  }).then((r) => r.json());

  for (const role of ['Admin', 'Manager', 'Agent']) {
    const member = await createTeamMemberJwt(role);
    const getRes = await fetch(`${baseUrl}/api/canned-responses`, { headers: authed(member.jwt) });
    assert.equal(getRes.status, 200, `${role} should be able to GET`);

    const postRes = await fetch(`${baseUrl}/api/canned-responses`, {
      method: 'POST',
      headers: authed(member.jwt),
      body: JSON.stringify({ shortcut: `${SUITE_PREFIX}/from-${role}`, body: 'x' }),
    });
    const deleteRes = await fetch(`${baseUrl}/api/canned-responses/${created.id}`, {
      method: 'DELETE',
      headers: authed(member.jwt),
    });

    if (role === 'Agent') {
      assert.equal(postRes.status, 403, 'Agent should be forbidden from POST');
      assert.equal(deleteRes.status, 403, 'Agent should be forbidden from DELETE');
    } else {
      assert.equal(postRes.status, 201, `${role} should be able to POST`);
    }
  }
});

test('3. a duplicate shortcut within the same client is rejected with 409', async () => {
  const shortcut = `${SUITE_PREFIX}/dup`;
  const first = await fetch(`${baseUrl}/api/canned-responses`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ shortcut, body: 'first' }),
  });
  assert.equal(first.status, 201);

  const second = await fetch(`${baseUrl}/api/canned-responses`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ shortcut, body: 'second, should collide' }),
  });
  assert.equal(second.status, 409);
});

test('4. tenant isolation: another client cannot see or delete this client\'s canned responses', async () => {
  const created = await fetch(`${baseUrl}/api/canned-responses`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ shortcut: `${SUITE_PREFIX}/isolated`, body: 'should not leak' }),
  }).then((r) => r.json());

  const otherList = await fetch(`${baseUrl}/api/canned-responses`, { headers: authed(otherClientToken) }).then((r) => r.json());
  assert.ok(!otherList.some((c) => c.id === created.id), 'must not appear in another client\'s list');

  const deleteRes = await fetch(`${baseUrl}/api/canned-responses/${created.id}`, {
    method: 'DELETE',
    headers: authed(otherClientToken),
  });
  assert.equal(deleteRes.status, 404, 'another client deleting it must 404, not succeed');

  // confirm it's genuinely still there for the real owner
  const ownList = await fetch(`${baseUrl}/api/canned-responses`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.ok(ownList.some((c) => c.id === created.id));
});

test('5. unauthenticated requests are rejected', async () => {
  const res = await fetch(`${baseUrl}/api/canned-responses`);
  assert.equal(res.status, 401);
});

test('6. an empty shortcut or body is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/canned-responses`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ shortcut: '', body: '' }),
  });
  assert.equal(res.status, 400);
});
