// PLAN.md item 7 — per-contact custom attribute values. Verifies:
// 1. GET /:id/attributes on a contact with no values yet returns an empty list.
// 2. PUT upserts a text value; GET reflects it.
// 3. number type: "abc" -> 400, "42" -> 200.
// 4. date type: "2026-13-40" -> 400 (fails real calendar-date validity, not
//    just the regex shape), "2026-09-15" -> 200.
// 5. boolean type: "yes" -> 400, "true" -> 200.
// 6. PUT again on the same attribute updates in place (still one row, no
//    unique-constraint conflict surfacing as an error).
// 7. Deleting the attribute definition cascades the value row away (real DB
//    check, not just a 404 on next read).
// 8. Tenant isolation — a value never shows up under another client.
// 9. Role gating (Agent allowed, matching item 1's Contacts row) and
//    unauthenticated rejection.
// 10. 404s: unknown contact id, unknown/foreign attribute id.
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

const SUITE_PREFIX = '__test_suite__contactattrvalues_';
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
      email: `test-suite-contactattrvalues-${suffix}-${Date.now()}@wasi.local`,
      password: PASSWORD,
    }),
  }).then((r) => r.json());
  return { token: registered.token, id: registered.client?.id };
}

async function createAttribute(token, name, type) {
  return fetch(`${baseUrl}/api/contact-attributes`, {
    method: 'POST', headers: authed(token),
    body: JSON.stringify({ name, type }),
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
    body: JSON.stringify({ name: `${SUITE_PREFIX}Contact`, phone: `9199${Date.now()}`.slice(0, 12) }),
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

test('1. GET /:id/attributes on a contact with no values yet returns an empty list', async () => {
  const res = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.values, []);
});

test('2. PUT upserts a text value; GET reflects it', async () => {
  const attr = await createAttribute(clientToken, `${SUITE_PREFIX}city`, 'text');
  const put = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attr.id}`, {
    method: 'PUT', headers: authed(clientToken), body: JSON.stringify({ value: 'Mumbai' }),
  });
  assert.equal(put.status, 200);
  const putData = await put.json();
  assert.equal(putData.value, 'Mumbai');
  assert.equal(putData.name, `${SUITE_PREFIX}city`);
  assert.equal(putData.type, 'text');

  const get = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes`, { headers: authed(clientToken) });
  const getData = await get.json();
  assert.ok(getData.values.some((v) => v.attributeId === attr.id && v.value === 'Mumbai' && v.name === `${SUITE_PREFIX}city`));
});

test('3. number type: "abc" -> 400, "42" -> 200', async () => {
  const attr = await createAttribute(clientToken, `${SUITE_PREFIX}age`, 'number');
  const bad = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attr.id}`, {
    method: 'PUT', headers: authed(clientToken), body: JSON.stringify({ value: 'abc' }),
  });
  assert.equal(bad.status, 400);

  const good = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attr.id}`, {
    method: 'PUT', headers: authed(clientToken), body: JSON.stringify({ value: '42' }),
  });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).value, '42');
});

test('4. date type: an invalid calendar date -> 400, a real ISO date -> 200', async () => {
  const attr = await createAttribute(clientToken, `${SUITE_PREFIX}birthday`, 'date');
  const bad = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attr.id}`, {
    method: 'PUT', headers: authed(clientToken), body: JSON.stringify({ value: '2026-13-40' }),
  });
  assert.equal(bad.status, 400);

  const good = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attr.id}`, {
    method: 'PUT', headers: authed(clientToken), body: JSON.stringify({ value: '2026-09-15' }),
  });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).value, '2026-09-15');
});

test('5. boolean type: "yes" -> 400, "true" -> 200', async () => {
  const attr = await createAttribute(clientToken, `${SUITE_PREFIX}vip`, 'boolean');
  const bad = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attr.id}`, {
    method: 'PUT', headers: authed(clientToken), body: JSON.stringify({ value: 'yes' }),
  });
  assert.equal(bad.status, 400);

  const good = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attr.id}`, {
    method: 'PUT', headers: authed(clientToken), body: JSON.stringify({ value: 'true' }),
  });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).value, 'true');
});

test('6. PUT again on the same attribute updates in place — still exactly one row', async () => {
  const attr = await createAttribute(clientToken, `${SUITE_PREFIX}nickname`, 'text');
  await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attr.id}`, {
    method: 'PUT', headers: authed(clientToken), body: JSON.stringify({ value: 'First' }),
  });
  const second = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attr.id}`, {
    method: 'PUT', headers: authed(clientToken), body: JSON.stringify({ value: 'Second' }),
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).value, 'Second');

  const rowCount = await pool.query(
    'select count(*)::int as n from contact_attribute_values where contact_id = $1 and attribute_id = $2',
    [contactId, attr.id]
  );
  assert.equal(rowCount.rows[0].n, 1);
});

test('7. deleting the attribute definition cascades the value row away', async () => {
  const attr = await createAttribute(clientToken, `${SUITE_PREFIX}temp`, 'text');
  await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attr.id}`, {
    method: 'PUT', headers: authed(clientToken), body: JSON.stringify({ value: 'Gone Soon' }),
  });
  const before_ = await pool.query('select count(*)::int as n from contact_attribute_values where attribute_id = $1', [attr.id]);
  assert.equal(before_.rows[0].n, 1);

  const del = await fetch(`${baseUrl}/api/contact-attributes/${attr.id}`, { method: 'DELETE', headers: authed(clientToken) });
  assert.equal(del.status, 204);

  const after_ = await pool.query('select count(*)::int as n from contact_attribute_values where attribute_id = $1', [attr.id]);
  assert.equal(after_.rows[0].n, 0, 'the value row must cascade away with its attribute definition');
});

test('8. tenant isolation: a value never shows up under another client, and cannot be set cross-tenant', async () => {
  const attr = await createAttribute(clientToken, `${SUITE_PREFIX}secret`, 'text');
  await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attr.id}`, {
    method: 'PUT', headers: authed(clientToken), body: JSON.stringify({ value: 'Private' }),
  });

  // The other client can't even see this contact, let alone its attributes.
  const otherGet = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes`, { headers: authed(otherClientToken) });
  assert.equal(otherGet.status, 404);

  // Nor can it write to this attribute id, even if it guessed it.
  const otherPut = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attr.id}`, {
    method: 'PUT', headers: authed(otherClientToken), body: JSON.stringify({ value: 'Hijacked' }),
  });
  assert.equal(otherPut.status, 404);
});

test('9. role gating: Agent can read and write (matches item 1\'s Contacts row); unauthenticated is rejected', async () => {
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

  const attr = await createAttribute(clientToken, `${SUITE_PREFIX}agentwritable`, 'text');
  const asAgent = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attr.id}`, {
    method: 'PUT', headers: authed(accepted.token), body: JSON.stringify({ value: 'By Agent' }),
  });
  assert.equal(asAgent.status, 200);

  const unauth = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes`);
  assert.equal(unauth.status, 401);
});

test('10. 404s: unknown contact id, unknown/foreign attribute id', async () => {
  const unknownContact = await fetch(`${baseUrl}/api/contacts/00000000-0000-0000-0000-000000000099/attributes`, { headers: authed(clientToken) });
  assert.equal(unknownContact.status, 404);

  const unknownAttr = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/00000000-0000-0000-0000-000000000099`, {
    method: 'PUT', headers: authed(clientToken), body: JSON.stringify({ value: 'X' }),
  });
  assert.equal(unknownAttr.status, 404);

  // An attribute that exists but belongs to the OTHER client entirely.
  const foreignAttr = await createAttribute(otherClientToken, `${SUITE_PREFIX}foreign`, 'text');
  const crossTenant = await fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${foreignAttr.id}`, {
    method: 'PUT', headers: authed(clientToken), body: JSON.stringify({ value: 'X' }),
  });
  assert.equal(crossTenant.status, 404);
});
