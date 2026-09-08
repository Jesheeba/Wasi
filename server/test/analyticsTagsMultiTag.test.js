// Real bug, fixed: GET /api/analytics/tags used to join on contacts.tag_id
// only, the same blind spot broadcastRecipientsRepo.createFromAudience had
// before its Option B fix — a contact tagged via item 8/8.5's additive
// contact_tags picker never counted toward its tag's contact_count,
// silently understating a real client-facing analytics number. Fixed with
// the same OR EXISTS shape, not a replacement (contacts.tag_id still has
// one real, live write path — the Automation Flow Builder's Assign Tag
// action node — this must not regress). Verifies:
// 1. A contact tagged ONLY via contact_tags now counts toward contact_count.
// 2. A contact tagged ONLY via contacts.tag_id directly still counts — no regression.
// 3. A contact matching via BOTH mechanisms (e.g. migration 050's backfill
//    shape) is counted exactly once, not twice.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server, baseUrl, clientToken, testClientId;

const SUITE_PREFIX = '__test_suite__analyticstagsmultitag_';
const PASSWORD = 'test-suite-password-12345';

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
      email: `test-suite-analyticstagsmultitag-${Date.now()}@wasi.local`,
      password: PASSWORD,
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function createTag(name) {
  return fetch(`${baseUrl}/api/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name }) }).then((r) => r.json());
}
async function createContact(name, phone) {
  return fetch(`${baseUrl}/api/contacts`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name, phone }) }).then((r) => r.json());
}
async function getTagRow(tagId) {
  const rows = await fetch(`${baseUrl}/api/analytics/tags`, { headers: authed(clientToken) }).then((r) => r.json());
  return rows.find((r) => r.id === tagId);
}

test('1. a contact tagged ONLY via the additive contact_tags endpoint now counts toward contact_count', async () => {
  const tag = await createTag(`${SUITE_PREFIX}MultiOnly_${Date.now()}`);
  const contact = await createContact(`${SUITE_PREFIX}C1`, `9180${String(Date.now()).slice(-8)}`);
  await fetch(`${baseUrl}/api/contacts/${contact.id}/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ tagId: tag.id }) });

  const row = await getTagRow(tag.id);
  assert.ok(row, 'the tag itself must still appear in the report even before this fix');
  assert.equal(row.contact_count, 1, 'a contact_tags-only tag must now count — this is the exact bug that was reported');
});

test('2. a contact tagged ONLY via contacts.tag_id directly (the flow builder\'s Assign Tag path) still counts — no regression', async () => {
  const tag = await createTag(`${SUITE_PREFIX}PrimaryOnly_${Date.now()}`);
  const contact = await createContact(`${SUITE_PREFIX}C2`, `9181${String(Date.now()).slice(-8)}`);
  await pool.query('update contacts set tag_id = $1 where id = $2', [tag.id, contact.id]);

  const row = await getTagRow(tag.id);
  assert.equal(row.contact_count, 1);
});

test('3. a contact matching via BOTH mechanisms is counted exactly once, not twice', async () => {
  const tag = await createTag(`${SUITE_PREFIX}Both_${Date.now()}`);
  const contact = await createContact(`${SUITE_PREFIX}C3`, `9182${String(Date.now()).slice(-8)}`);
  await pool.query('update contacts set tag_id = $1 where id = $2', [tag.id, contact.id]);
  await fetch(`${baseUrl}/api/contacts/${contact.id}/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ tagId: tag.id }) });

  const row = await getTagRow(tag.id);
  assert.equal(row.contact_count, 1, 'a contact matching via both tag_id AND contact_tags must not be double-counted');
});
