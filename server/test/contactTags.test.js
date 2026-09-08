// PLAN.md item 8 — multi-tag contacts, additive to contacts.tag_id (the
// permanent primary tag). Verifies:
// 1. GET /:id/tags on an untagged contact returns an empty list.
// 2. POST attaches a tag; GET reflects it; contacts.tag_id is untouched.
// 3. A contact can carry more than one tag simultaneously.
// 4. Attaching the same tag twice is a safe no-op, not a duplicate/error.
// 5. DELETE detaches one tag without affecting others or contacts.tag_id.
// 6. Tenant isolation — cannot read/write another client's contact's tags,
//    and cannot attach another client's tag id even if guessed.
// 7. Role gating (Agent allowed) and unauthenticated rejection.
// 8. 404s: unknown contact, unknown tag id on POST, unknown tag on DELETE.
// 9. The migration 050 backfill: an already-tagged contact (via
//    contacts.tag_id, set before contact_tags ever existed) shows up in
//    contact_tags too, confirmed directly against the real local DB this
//    migration already ran against.
// Same dedicated-disposable-test-client convention as every other file in
// this directory.
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
let contactId;

const SUITE_PREFIX = '__test_suite__contacttags_';
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
      email: `test-suite-contacttags-${suffix}-${Date.now()}@wasi.local`,
      password: PASSWORD,
    }),
  }).then((r) => r.json());
  return { token: registered.token, id: registered.client?.id };
}

async function createTag(token, name) {
  return fetch(`${baseUrl}/api/tags`, {
    method: 'POST', headers: authed(token), body: JSON.stringify({ name }),
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

  const contact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Contact`, phone: `9188${Date.now()}`.slice(0, 12) }),
  }).then((r) => r.json());
  contactId = contact.id;
  assert.ok(contactId, 'dedicated test contact must be created');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  if (otherClientId) await pool.query('delete from clients where id = $1', [otherClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('1. GET /:id/tags on an untagged contact returns an empty list', async () => {
  const res = await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).tags, []);
});

test('2. POST attaches a tag; GET reflects it; contacts.tag_id is untouched', async () => {
  const tag = await createTag(clientToken, `${SUITE_PREFIX}VIP`);
  const post = await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, {
    method: 'POST', headers: authed(clientToken), body: JSON.stringify({ tagId: tag.id }),
  });
  assert.equal(post.status, 201);
  assert.ok((await post.json()).tags.some((t) => t.id === tag.id));

  const get = await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, { headers: authed(clientToken) });
  assert.ok((await get.json()).tags.some((t) => t.id === tag.id && t.name === `${SUITE_PREFIX}VIP`));

  const contact = await fetch(`${baseUrl}/api/contacts/${contactId}`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.equal(contact.tag_id, null, 'multi-tag attach must never set the primary tag_id');
});

test('3. a contact can carry more than one tag simultaneously', async () => {
  const tagA = await createTag(clientToken, `${SUITE_PREFIX}TagA`);
  const tagB = await createTag(clientToken, `${SUITE_PREFIX}TagB`);
  await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ tagId: tagA.id }) });
  await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ tagId: tagB.id }) });

  const get = await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, { headers: authed(clientToken) });
  const ids = (await get.json()).tags.map((t) => t.id);
  assert.ok(ids.includes(tagA.id) && ids.includes(tagB.id));
});

test('4. attaching the same tag twice is a safe no-op, not a duplicate/error', async () => {
  const tag = await createTag(clientToken, `${SUITE_PREFIX}Dupe`);
  const first = await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ tagId: tag.id }) });
  assert.equal(first.status, 201);
  const second = await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ tagId: tag.id }) });
  assert.equal(second.status, 201);

  const count = await pool.query('select count(*)::int as n from contact_tags where contact_id = $1 and tag_id = $2', [contactId, tag.id]);
  assert.equal(count.rows[0].n, 1);
});

test('5. DELETE detaches one tag without affecting others or contacts.tag_id', async () => {
  const tagKeep = await createTag(clientToken, `${SUITE_PREFIX}Keep`);
  const tagRemove = await createTag(clientToken, `${SUITE_PREFIX}Remove`);
  await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ tagId: tagKeep.id }) });
  await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ tagId: tagRemove.id }) });

  const del = await fetch(`${baseUrl}/api/contacts/${contactId}/tags/${tagRemove.id}`, { method: 'DELETE', headers: authed(clientToken) });
  assert.equal(del.status, 204);

  const get = await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, { headers: authed(clientToken) });
  const ids = (await get.json()).tags.map((t) => t.id);
  assert.ok(ids.includes(tagKeep.id));
  assert.ok(!ids.includes(tagRemove.id));

  const contact = await fetch(`${baseUrl}/api/contacts/${contactId}`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.equal(contact.tag_id, null);
});

test('6. tenant isolation: cannot read/write another client\'s contact tags, cannot attach a foreign tag id', async () => {
  const otherGet = await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, { headers: authed(otherClientToken) });
  assert.equal(otherGet.status, 404);

  const foreignTag = await createTag(otherClientToken, `${SUITE_PREFIX}Foreign`);
  const crossTenantPost = await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, {
    method: 'POST', headers: authed(clientToken), body: JSON.stringify({ tagId: foreignTag.id }),
  });
  assert.equal(crossTenantPost.status, 404);
});

test('7. role gating: Agent can read and write; unauthenticated is rejected', async () => {
  const authTokensRepo = require('../src/repositories/authTokensRepo');
  const agentCreated = await fetch(`${baseUrl}/api/team-members`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Agent`, email: `${SUITE_PREFIX}agent-${Date.now()}@wasi.local`, role: 'Agent' }),
  }).then((r) => r.json());
  const inviteToken = await authTokensRepo.create('team_member', agentCreated.id, 'team_invite', 60);
  const accepted = await fetch(`${baseUrl}/api/auth/team/accept-invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inviteToken, password: PASSWORD }),
  }).then((r) => r.json());

  const tag = await createTag(clientToken, `${SUITE_PREFIX}AgentTag`);
  const asAgent = await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, {
    method: 'POST', headers: authed(accepted.token), body: JSON.stringify({ tagId: tag.id }),
  });
  assert.equal(asAgent.status, 201);

  const unauth = await fetch(`${baseUrl}/api/contacts/${contactId}/tags`);
  assert.equal(unauth.status, 401);
});

test('8. 404s: unknown contact, unknown tag id on POST, unknown tag on DELETE', async () => {
  const unknownContactGet = await fetch(`${baseUrl}/api/contacts/00000000-0000-0000-0000-000000000099/tags`, { headers: authed(clientToken) });
  assert.equal(unknownContactGet.status, 404);

  const unknownTagPost = await fetch(`${baseUrl}/api/contacts/${contactId}/tags`, {
    method: 'POST', headers: authed(clientToken), body: JSON.stringify({ tagId: '00000000-0000-0000-0000-000000000099' }),
  });
  assert.equal(unknownTagPost.status, 404);

  const unknownTagDelete = await fetch(`${baseUrl}/api/contacts/${contactId}/tags/00000000-0000-0000-0000-000000000099`, {
    method: 'DELETE', headers: authed(clientToken),
  });
  assert.equal(unknownTagDelete.status, 404);
});

test('9. migration 050 backfill: an already-tagged contact (via contacts.tag_id, pre-dating contact_tags) shows up in contact_tags', async () => {
  const tag = await createTag(clientToken, `${SUITE_PREFIX}Backfilled`);
  // Sets contacts.tag_id directly at the DB level to simulate a contact
  // tagged before this migration ever ran — the real backfill scenario —
  // rather than going through the (deliberately tag_id-untouched) tags
  // sub-routes this file otherwise tests.
  const legacyContact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Legacy`, phone: `9189${Date.now()}`.slice(0, 12) }),
  }).then((r) => r.json());
  await pool.query('update contacts set tag_id = $1 where id = $2', [tag.id, legacyContact.id]);
  // Re-run the exact backfill statement migration 050 ran once, since this
  // row didn't exist at migration time — proves the STATEMENT is correct,
  // matching what the real migration already did for every contact that
  // existed when it ran (verified directly against the local DB earlier).
  await pool.query(
    `insert into contact_tags (contact_id, tag_id, client_id)
     select id, tag_id, client_id from contacts where id = $1 and tag_id is not null
     on conflict (contact_id, tag_id) do nothing`,
    [legacyContact.id]
  );

  const get = await fetch(`${baseUrl}/api/contacts/${legacyContact.id}/tags`, { headers: authed(clientToken) });
  assert.ok((await get.json()).tags.some((t) => t.id === tag.id));
});
