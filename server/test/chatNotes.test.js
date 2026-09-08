// PLAN.md item 3 — internal notes with @mention. Verifies:
// 1. A note is created and returned with mentions resolved to {id, name}.
// 2. Notes never appear in the customer-facing GET /:id/messages.
// 3. A mention referencing a team member from another client is rejected.
// 4. GET/POST are reachable by any team role (Admin/Manager/Agent per
//    item 1's matrix), unlike Admin/Manager-only routes elsewhere.
// 5. The owner (no team_members row) can author a note; author is null.
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
let otherClientId;

const SUITE_PREFIX = '__test_suite__chatnotes_';
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
      email: `test-suite-chatnotes-${suffix}-${Date.now()}@wasi.local`,
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
  otherClientId = other.id;
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  if (otherClientId) await pool.query('delete from clients where id = $1', [otherClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function createTeamMemberJwt(clientToken_, role) {
  const created = await fetch(`${baseUrl}/api/team-members`, {
    method: 'POST',
    headers: authed(clientToken_),
    body: JSON.stringify({ name: `${SUITE_PREFIX}${role}`, email: `${SUITE_PREFIX}${role}-${Date.now()}@wasi.local`, role }),
  }).then((r) => r.json());

  const token = await authTokensRepo.create('team_member', created.id, 'team_invite', 60);
  const accepted = await fetch(`${baseUrl}/api/auth/team/accept-invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password: PASSWORD }),
  }).then((r) => r.json());
  return { id: created.id, name: `${SUITE_PREFIX}${role}`, jwt: accepted.token };
}

async function createChat(token, name) {
  return fetch(`${baseUrl}/api/chats`, {
    method: 'POST',
    headers: authed(token),
    body: JSON.stringify({ name, phone: `9170${Date.now()}`.slice(0, 12) }),
  }).then((r) => r.json());
}

test('1. a note is created with mentions resolved to {id, name}, and appears in GET /:id/notes', async () => {
  const agent = await createTeamMemberJwt(clientToken, 'Agent');
  const mentioned = await createTeamMemberJwt(clientToken, 'Manager');
  const chat = await createChat(clientToken, `${SUITE_PREFIX}note-chat`);

  const createRes = await fetch(`${baseUrl}/api/chats/${chat.id}/notes`, {
    method: 'POST',
    headers: authed(agent.jwt),
    body: JSON.stringify({ body: 'Customer wants a refund, @mentioning you', mentions: [mentioned.id] }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.body, 'Customer wants a refund, @mentioning you');
  assert.equal(created.author.id, agent.id);
  assert.equal(created.author.name, agent.name);
  assert.equal(created.mentions.length, 1);
  assert.equal(created.mentions[0].id, mentioned.id);
  assert.equal(created.mentions[0].name, mentioned.name);

  const listRes = await fetch(`${baseUrl}/api/chats/${chat.id}/notes`, { headers: authed(clientToken) });
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);
});

test('2. a note never appears in the customer-facing GET /:id/messages', async () => {
  const agent = await createTeamMemberJwt(clientToken, 'Agent');
  const chat = await createChat(clientToken, `${SUITE_PREFIX}separation-chat`);

  await fetch(`${baseUrl}/api/chats/${chat.id}/notes`, {
    method: 'POST',
    headers: authed(agent.jwt),
    body: JSON.stringify({ body: 'internal only, never send this to the customer' }),
  });

  const messagesRes = await fetch(`${baseUrl}/api/chats/${chat.id}/messages`, { headers: authed(clientToken) });
  const messages = await messagesRes.json();
  assert.equal(messages.length, 0, 'the note must not leak into the real WhatsApp message thread');
});

test('3. a mention referencing another client\'s team member is rejected (400), not silently dropped or accepted', async () => {
  const agent = await createTeamMemberJwt(clientToken, 'Agent');
  const otherClientToken = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: (await pool.query('select email from clients where id = $1', [otherClientId])).rows[0].email, password: PASSWORD }),
  }).then((r) => r.json()).then((d) => d.token);
  const foreignMember = await createTeamMemberJwt(otherClientToken, 'Admin');
  const chat = await createChat(clientToken, `${SUITE_PREFIX}cross-client-mention`);

  const res = await fetch(`${baseUrl}/api/chats/${chat.id}/notes`, {
    method: 'POST',
    headers: authed(agent.jwt),
    body: JSON.stringify({ body: 'trying to mention someone from another client', mentions: [foreignMember.id] }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.invalid.includes(foreignMember.id));
});

test('4. GET and POST /:id/notes are reachable by Admin, Manager, and Agent alike (unlike Admin/Manager-only routes)', async () => {
  const chat = await createChat(clientToken, `${SUITE_PREFIX}role-matrix`);
  for (const role of ['Admin', 'Manager', 'Agent']) {
    const member = await createTeamMemberJwt(clientToken, role);
    const postRes = await fetch(`${baseUrl}/api/chats/${chat.id}/notes`, {
      method: 'POST',
      headers: authed(member.jwt),
      body: JSON.stringify({ body: `note from ${role}` }),
    });
    assert.equal(postRes.status, 201, `${role} should be able to post a note`);
    const getRes = await fetch(`${baseUrl}/api/chats/${chat.id}/notes`, { headers: authed(member.jwt) });
    assert.equal(getRes.status, 200, `${role} should be able to read notes`);
  }
});

test('5. the owner can author a note directly; author is null (no team_members row to attribute it to)', async () => {
  const chat = await createChat(clientToken, `${SUITE_PREFIX}owner-note`);
  const res = await fetch(`${baseUrl}/api/chats/${chat.id}/notes`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ body: 'note from the account owner directly' }),
  });
  assert.equal(res.status, 201);
  const note = await res.json();
  assert.equal(note.author, null);
  assert.deepEqual(note.mentions, []);
});

test('6. an empty body is rejected', async () => {
  const chat = await createChat(clientToken, `${SUITE_PREFIX}empty-body`);
  const res = await fetch(`${baseUrl}/api/chats/${chat.id}/notes`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ body: '' }),
  });
  assert.equal(res.status, 400);
});

test('7. notes for an unknown/foreign chat id 404, not a crash', async () => {
  const res = await fetch(`${baseUrl}/api/chats/00000000-0000-0000-0000-000000000099/notes`, { headers: authed(clientToken) });
  assert.equal(res.status, 404);
});
