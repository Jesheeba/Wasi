// Chat assignment (GAP_FIX_PLAN.md Phase E2 — attribution-only team
// inbox: PATCH /api/chats/:id/assign, server/src/routes/chats.js). Same
// dedicated-disposable-client pattern as the other test files.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;
let clientToken;
let testClientId;
let chatId;
let memberId;

const SUITE_PREFIX = '__test_suite__chatAssignment_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
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
      email: `test-suite-chatassign-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  const chat = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Contact`, phone: '910000000002' }),
  }).then((r) => r.json());
  chatId = chat.id;

  const member = await fetch(`${baseUrl}/api/team-members`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Agent`, email: `agent-${Date.now()}@example.com` }),
  }).then((r) => r.json());
  memberId = member.id;
  assert.ok(chatId && memberId, 'test chat and team member creation must succeed');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('unauthenticated request is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/chats/${chatId}/assign`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team_member_id: memberId }),
  });
  assert.equal(res.status, 401);
});

test('assigns a chat to a real team member', async () => {
  const res = await fetch(`${baseUrl}/api/chats/${chatId}/assign`, {
    method: 'PATCH',
    headers: authed(clientToken),
    body: JSON.stringify({ team_member_id: memberId }),
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.assigned_to, memberId);

  const fetched = await fetch(`${baseUrl}/api/chats/${chatId}`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.equal(fetched.assigned_to, memberId, 'assignment persists');
});

test('unassigns with team_member_id: null', async () => {
  await fetch(`${baseUrl}/api/chats/${chatId}/assign`, {
    method: 'PATCH',
    headers: authed(clientToken),
    body: JSON.stringify({ team_member_id: memberId }),
  });

  const res = await fetch(`${baseUrl}/api/chats/${chatId}/assign`, {
    method: 'PATCH',
    headers: authed(clientToken),
    body: JSON.stringify({ team_member_id: null }),
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.assigned_to, null);
});

test('assigning to a non-existent team member returns a clean 404, not a raw FK error', async () => {
  const res = await fetch(`${baseUrl}/api/chats/${chatId}/assign`, {
    method: 'PATCH',
    headers: authed(clientToken),
    body: JSON.stringify({ team_member_id: '00000000-0000-0000-0000-000000000099' }),
  });
  assert.equal(res.status, 404);
});

test('assigning a non-existent chat returns 404', async () => {
  const res = await fetch(`${baseUrl}/api/chats/00000000-0000-0000-0000-000000000099/assign`, {
    method: 'PATCH',
    headers: authed(clientToken),
    body: JSON.stringify({ team_member_id: memberId }),
  });
  assert.equal(res.status, 404);
});

test('removing a team member un-assigns their chats (ON DELETE SET NULL), not a delete failure', async () => {
  await fetch(`${baseUrl}/api/chats/${chatId}/assign`, {
    method: 'PATCH',
    headers: authed(clientToken),
    body: JSON.stringify({ team_member_id: memberId }),
  });

  const deleteRes = await fetch(`${baseUrl}/api/team-members/${memberId}`, {
    method: 'DELETE',
    headers: authed(clientToken),
  });
  assert.equal(deleteRes.status, 204);

  const fetched = await fetch(`${baseUrl}/api/chats/${chatId}`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.equal(fetched.assigned_to, null, 'chat is automatically un-assigned, not left dangling or blocking the delete');
});
