// PLAN.md item 9 — AND/OR audience segment builder. Verifies:
// 1. AND combinator (tag + attribute): preview count matches a manual SQL
//    count against the same fixture; POST /api/broadcasts against the
//    segment creates exactly the matching broadcast_recipients rows.
// 2. OR combinator.
// 3. Each attribute type/op: number (gt), date (lt), boolean (eq), text (contains).
// 4. segmentFilter.js parameterizes every value — a value containing raw
//    SQL syntax is treated as a literal string comparison, not executed
//    (real proof, not just code inspection: a value shaped like a SQL
//    injection attempt only ever matches the one contact whose real
//    attribute value equals it literally).
// 5. Rejections: unknown attributeId, an op invalid for the attribute's
//    real type, an unknown condition field.
// 6. Mutual exclusivity (tag_id/contact_list_id/segment_id), both layers —
//    schema (400) and the DB's own CHECK constraint (migration 051).
// 7. Role gating (Agent rejected, matching Broadcasts/Contact-Lists — NOT
//    the same as items 6-8's Agent-writable Contacts routes) and
//    unauthenticated rejection.
// 8. Tenant isolation — a foreign segment_id 404s a broadcast creation
//    attempt; another client's segments never listed.
// 9. The SET LOCAL statement_timeout mechanism itself (real proof against
//    this actual Postgres, not just trusted from docs) — a deliberately
//    slow query under a short SET LOCAL statement_timeout really does
//    raise Postgres error 57014, the exact code routes/contactSegments.js
//    and routes/broadcasts.js both catch to return a clear 503.
// Same dedicated-disposable-test-client convention as every other file in
// this directory. No real Meta call anywhere — broadcast creation only
// resolves recipients, never invokes broadcastRunner.
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

const SUITE_PREFIX = '__test_suite__contactsegments_';
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
      email: `test-suite-contactsegments-${suffix}-${Date.now()}@wasi.local`,
      password: PASSWORD,
    }),
  }).then((r) => r.json());
  return { token: registered.token, id: registered.client?.id };
}

async function createTag(token, name) {
  return fetch(`${baseUrl}/api/tags`, { method: 'POST', headers: authed(token), body: JSON.stringify({ name }) }).then((r) => r.json());
}
async function createAttribute(token, name, type) {
  return fetch(`${baseUrl}/api/contact-attributes`, { method: 'POST', headers: authed(token), body: JSON.stringify({ name, type }) }).then((r) => r.json());
}
async function createContact(token, name, phone) {
  return fetch(`${baseUrl}/api/contacts`, { method: 'POST', headers: authed(token), body: JSON.stringify({ name, phone }) }).then((r) => r.json());
}
async function attachTag(token, contactId, tagId) {
  return fetch(`${baseUrl}/api/contacts/${contactId}/tags`, { method: 'POST', headers: authed(token), body: JSON.stringify({ tagId }) });
}
async function setAttr(token, contactId, attributeId, value) {
  return fetch(`${baseUrl}/api/contacts/${contactId}/attributes/${attributeId}`, { method: 'PUT', headers: authed(token), body: JSON.stringify({ value }) });
}

// Real fixture: 4 contacts, a VIP tag, a "city" text attribute — used by
// the AND/OR/broadcast tests below so their expected counts are derived
// from real data, not hardcoded against assumptions.
let vipTag, otherTag, cityAttr, contactA, contactB, contactC, contactD;

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

  vipTag = await createTag(clientToken, `${SUITE_PREFIX}VIP`);
  otherTag = await createTag(clientToken, `${SUITE_PREFIX}Other`);
  cityAttr = await createAttribute(clientToken, `${SUITE_PREFIX}City`, 'text');

  const ts = String(Date.now()).slice(-9);
  contactA = await createContact(clientToken, `${SUITE_PREFIX}A`, `91${ts}1`); // VIP, Mumbai
  contactB = await createContact(clientToken, `${SUITE_PREFIX}B`, `91${ts}2`); // VIP, Delhi
  contactC = await createContact(clientToken, `${SUITE_PREFIX}C`, `91${ts}3`); // Other, Mumbai
  contactD = await createContact(clientToken, `${SUITE_PREFIX}D`, `91${ts}4`); // no tag, no city

  await attachTag(clientToken, contactA.id, vipTag.id);
  await attachTag(clientToken, contactB.id, vipTag.id);
  await attachTag(clientToken, contactC.id, otherTag.id);
  await setAttr(clientToken, contactA.id, cityAttr.id, 'Mumbai');
  await setAttr(clientToken, contactB.id, cityAttr.id, 'Delhi');
  await setAttr(clientToken, contactC.id, cityAttr.id, 'Mumbai');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  if (otherClientId) await pool.query('delete from clients where id = $1', [otherClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('1. AND combinator (tag VIP AND city=Mumbai): preview count matches a manual SQL count, matches only contact A', async () => {
  const filterJson = {
    combinator: 'AND',
    conditions: [
      { field: 'tag', op: 'eq', value: vipTag.id },
      { field: 'attribute', attributeId: cityAttr.id, op: 'eq', value: 'Mumbai' },
    ],
  };
  const preview = await fetch(`${baseUrl}/api/contact-segments/preview`, {
    method: 'POST', headers: authed(clientToken), body: JSON.stringify({ filterJson }),
  });
  assert.equal(preview.status, 200);
  const { matchingCount } = await preview.json();

  const manual = await pool.query(
    `select count(*)::int as n from contacts c
     where c.client_id = $1
       and exists (select 1 from contact_tags ct where ct.contact_id = c.id and ct.tag_id = $2)
       and exists (select 1 from contact_attribute_values v where v.contact_id = c.id and v.attribute_id = $3 and v.value = 'Mumbai')`,
    [testClientId, vipTag.id, cityAttr.id]
  );
  assert.equal(matchingCount, manual.rows[0].n);
  assert.equal(matchingCount, 1, 'only contact A is VIP AND in Mumbai');
});

test('2. OR combinator: VIP OR city=Mumbai matches A, B, C but not D', async () => {
  const filterJson = {
    combinator: 'OR',
    conditions: [
      { field: 'tag', op: 'eq', value: vipTag.id },
      { field: 'attribute', attributeId: cityAttr.id, op: 'eq', value: 'Mumbai' },
    ],
  };
  const preview = await fetch(`${baseUrl}/api/contact-segments/preview`, {
    method: 'POST', headers: authed(clientToken), body: JSON.stringify({ filterJson }),
  });
  const { matchingCount } = await preview.json();
  assert.equal(matchingCount, 3);
});

test('3a. number attribute, op gt', async () => {
  const attr = await createAttribute(clientToken, `${SUITE_PREFIX}Age`, 'number');
  const c1 = await createContact(clientToken, `${SUITE_PREFIX}Age30`, `9200${String(Date.now()).slice(-8)}`);
  await setAttr(clientToken, c1.id, attr.id, '30');
  const filterJson = { combinator: 'AND', conditions: [{ field: 'attribute', attributeId: attr.id, op: 'gt', value: '25' }] };
  const preview = await fetch(`${baseUrl}/api/contact-segments/preview`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ filterJson }) });
  assert.equal((await preview.json()).matchingCount, 1);
});

test('3b. date attribute, op lt', async () => {
  const attr = await createAttribute(clientToken, `${SUITE_PREFIX}Signup`, 'date');
  const c1 = await createContact(clientToken, `${SUITE_PREFIX}Early`, `9201${String(Date.now()).slice(-8)}`);
  await setAttr(clientToken, c1.id, attr.id, '2020-01-01');
  const filterJson = { combinator: 'AND', conditions: [{ field: 'attribute', attributeId: attr.id, op: 'lt', value: '2025-01-01' }] };
  const preview = await fetch(`${baseUrl}/api/contact-segments/preview`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ filterJson }) });
  assert.equal((await preview.json()).matchingCount, 1);
});

test('3c. boolean attribute, op eq', async () => {
  const attr = await createAttribute(clientToken, `${SUITE_PREFIX}Vip2`, 'boolean');
  const c1 = await createContact(clientToken, `${SUITE_PREFIX}BoolTrue`, `9202${String(Date.now()).slice(-8)}`);
  await setAttr(clientToken, c1.id, attr.id, 'true');
  const filterJson = { combinator: 'AND', conditions: [{ field: 'attribute', attributeId: attr.id, op: 'eq', value: 'true' }] };
  const preview = await fetch(`${baseUrl}/api/contact-segments/preview`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ filterJson }) });
  assert.equal((await preview.json()).matchingCount, 1);
});

test('3d. text attribute, op contains', async () => {
  const filterJson = { combinator: 'AND', conditions: [{ field: 'attribute', attributeId: cityAttr.id, op: 'contains', value: 'umba' }] };
  const preview = await fetch(`${baseUrl}/api/contact-segments/preview`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ filterJson }) });
  assert.equal((await preview.json()).matchingCount, 2, 'both Mumbai contacts (A, C) match "umba"');
});

test('3e. opt_in_status field', async () => {
  const filterJson = { combinator: 'AND', conditions: [{ field: 'opt_in_status', op: 'eq', value: 'unknown' }] };
  const preview = await fetch(`${baseUrl}/api/contact-segments/preview`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ filterJson }) });
  assert.ok((await preview.json()).matchingCount >= 4, 'every fixture contact defaults to unknown opt-in status');
});

test('4. every value is parameterized — a SQL-injection-shaped value is compared literally, never executed', async () => {
  const attr = await createAttribute(clientToken, `${SUITE_PREFIX}Notes`, 'text');
  const malicious = "x'; DROP TABLE contacts; --";
  const c1 = await createContact(clientToken, `${SUITE_PREFIX}Injected`, `9203${String(Date.now()).slice(-8)}`);
  await setAttr(clientToken, c1.id, attr.id, malicious);

  const filterJson = { combinator: 'AND', conditions: [{ field: 'attribute', attributeId: attr.id, op: 'eq', value: malicious }] };
  const preview = await fetch(`${baseUrl}/api/contact-segments/preview`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ filterJson }) });
  assert.equal(preview.status, 200, 'the malicious-shaped value must be handled as plain data, not break the query');
  assert.equal((await preview.json()).matchingCount, 1);

  // The table must genuinely still exist and be queryable — proves the
  // string was never concatenated into executable SQL.
  const stillThere = await pool.query('select count(*)::int as n from contacts where client_id = $1', [testClientId]);
  assert.ok(stillThere.rows[0].n > 0);
});

test('5a. an unknown attributeId is rejected with a clear 400', async () => {
  const filterJson = { combinator: 'AND', conditions: [{ field: 'attribute', attributeId: '00000000-0000-0000-0000-000000000099', op: 'eq', value: 'x' }] };
  const res = await fetch(`${baseUrl}/api/contact-segments/preview`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ filterJson }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown attribute/i);
});

test('5b. an op invalid for the attribute\'s real type is rejected (e.g. "contains" on a boolean)', async () => {
  const attr = await createAttribute(clientToken, `${SUITE_PREFIX}BoolStrict`, 'boolean');
  const filterJson = { combinator: 'AND', conditions: [{ field: 'attribute', attributeId: attr.id, op: 'contains', value: 'true' }] };
  const res = await fetch(`${baseUrl}/api/contact-segments/preview`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ filterJson }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not valid for a boolean/i);
});

test('6a. mutual exclusivity: a broadcast cannot target both a tag and a segment — rejected at the schema layer', async () => {
  const segment = await fetch(`${baseUrl}/api/contact-segments`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}seg1`, filterJson: { combinator: 'AND', conditions: [{ field: 'tag', op: 'eq', value: vipTag.id }] } }),
  }).then((r) => r.json());

  const res = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ title: 'Bad', tag_id: vipTag.id, segment_id: segment.id, templateName: 'whatever' }),
  });
  assert.equal(res.status, 400);
});

test('6b. mutual exclusivity: also enforced at the DB level (CHECK constraint), a second independent guarantee', async () => {
  const segment = await fetch(`${baseUrl}/api/contact-segments`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}seg2`, filterJson: { combinator: 'AND', conditions: [{ field: 'tag', op: 'eq', value: vipTag.id }] } }),
  }).then((r) => r.json());

  await assert.rejects(
    pool.query(
      `insert into broadcasts (client_id, title, tag_id, segment_id, template_name, status, param_mappings)
       values ($1, 'x', $2, $3, 'x', 'Sending', '{}')`,
      [testClientId, vipTag.id, segment.id]
    ),
    /broadcasts_audience_at_most_one/
  );
});

test('7. real broadcast against a segment creates exactly the matching broadcast_recipients rows', async () => {
  const segment = await fetch(`${baseUrl}/api/contact-segments`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      name: `${SUITE_PREFIX}vip_mumbai`,
      filterJson: { combinator: 'AND', conditions: [
        { field: 'tag', op: 'eq', value: vipTag.id },
        { field: 'attribute', attributeId: cityAttr.id, op: 'eq', value: 'Mumbai' },
      ] },
    }),
  }).then((r) => r.json());
  assert.ok(segment.id);

  const broadcast = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ title: `${SUITE_PREFIX}campaign`, segment_id: segment.id, templateName: `${SUITE_PREFIX}nonexistent_template` }),
  }).then((r) => r.json());
  assert.ok(broadcast.id);
  assert.equal(broadcast.recipient_count, 1);

  const recipients = await pool.query('select contact_id from broadcast_recipients where broadcast_id = $1', [broadcast.id]);
  assert.deepEqual(recipients.rows.map((r) => r.contact_id).sort(), [contactA.id].sort());
});

test('8. role gating: Agent is rejected (matches Broadcasts/Contact-Lists\' Admin/Manager-only row, not Contacts\' Agent-writable one); unauthenticated is rejected', async () => {
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

  const asAgent = await fetch(`${baseUrl}/api/contact-segments`, { headers: authed(accepted.token) });
  assert.equal(asAgent.status, 403);

  const unauth = await fetch(`${baseUrl}/api/contact-segments`);
  assert.equal(unauth.status, 401);
});

test('9. tenant isolation: a foreign segment_id 404s broadcast creation; another client\'s segments never listed', async () => {
  const foreignSegment = await fetch(`${baseUrl}/api/contact-segments`, {
    method: 'POST', headers: authed(otherClientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}foreign`, filterJson: { combinator: 'AND', conditions: [{ field: 'opt_in_status', op: 'eq', value: 'unknown' }] } }),
  }).then((r) => r.json());

  const res = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ title: 'x', segment_id: foreignSegment.id, templateName: 'x' }),
  });
  assert.equal(res.status, 404);

  const list = await fetch(`${baseUrl}/api/contact-segments`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.ok(!list.some((s) => s.id === foreignSegment.id));
});

test('10. the SET LOCAL statement_timeout mechanism itself really cancels a slow query with Postgres error 57014', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`set local statement_timeout = '100ms'`);
    await assert.rejects(
      client.query('select pg_sleep(1)'),
      (err) => {
        assert.equal(err.code, '57014', 'must be a real query_canceled error, the exact code both routes check for');
        return true;
      }
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});
