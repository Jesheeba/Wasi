// Real user-facing bug, fixed (Option B, per explicit review): tag-based
// broadcast audience targeting (broadcastRecipientsRepo.createFromAudience)
// used to match ONLY contacts.tag_id — but no contact-editing UI has ever
// written that column; items 8/8.5's multi-tag chip picker only writes the
// separate, additive contact_tags table. A contact tagged VIP via that
// picker silently matched zero recipients when "VIP" was picked as a
// broadcast audience. Fixed with an OR, not a replacement — contacts.tag_id
// still has one real, live write path (the Automation Flow Builder's
// "Assign Tag" action node, flowEngine.js), which this fix must not
// regress. Verifies:
// 1. A contact tagged ONLY via the additive contact_tags endpoint now
//    matches a tag-based broadcast audience.
// 2. A contact tagged ONLY via contacts.tag_id directly (simulating the
//    flow builder's Assign Tag node) still matches — no regression.
// 3. A contact with neither still doesn't match.
// 4. The OR is scoped per-tag, not "any tag" — a contact tagged X via one
//    mechanism and Y via the other doesn't cross-match an audience of Y
//    just because they have SOME tag somewhere.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server, baseUrl, clientToken, testClientId;

const SUITE_PREFIX = '__test_suite__broadcasttagmultitag_';
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
      email: `test-suite-broadcasttagmultitag-${Date.now()}@wasi.local`,
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

async function createContact(name, phone) {
  return fetch(`${baseUrl}/api/contacts`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name, phone }) }).then((r) => r.json());
}
async function createTag(name) {
  return fetch(`${baseUrl}/api/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name }) }).then((r) => r.json());
}
async function launchAudienceBroadcast(title, tagId) {
  return fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ title, tag_id: tagId, templateName: `${SUITE_PREFIX}nonexistent_template` }),
  }).then((r) => r.json());
}

test('1. a contact tagged ONLY via the additive contact_tags endpoint (item 8\'s picker) now matches a tag-based broadcast audience', async () => {
  const tag = await createTag(`${SUITE_PREFIX}VIP_${Date.now()}`);
  const contact = await createContact(`${SUITE_PREFIX}MultiTagOnly`, `9170${String(Date.now()).slice(-8)}`);
  await fetch(`${baseUrl}/api/contacts/${contact.id}/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ tagId: tag.id }) });

  const contactAfter = await fetch(`${baseUrl}/api/contacts/${contact.id}`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.equal(contactAfter.tag_id, null, 'sanity check: the additive picker must never have set the primary tag_id');

  const broadcast = await launchAudienceBroadcast(`${SUITE_PREFIX}camp1`, tag.id);
  assert.equal(broadcast.recipient_count, 1, 'a contact_tags-only tag must now match — this is the exact bug that was reported');

  const recipient = await pool.query('select 1 from broadcast_recipients where broadcast_id = $1 and contact_id = $2', [broadcast.id, contact.id]);
  assert.equal(recipient.rows.length, 1);
});

test('2. a contact tagged ONLY via contacts.tag_id directly (the flow builder\'s Assign Tag path) still matches — no regression', async () => {
  const tag = await createTag(`${SUITE_PREFIX}Flow_${Date.now()}`);
  const contact = await createContact(`${SUITE_PREFIX}PrimaryTagOnly`, `9171${String(Date.now()).slice(-8)}`);
  // Simulates flowEngine.js's assign_tag action (contactsRepo.update({tag_id})) directly.
  await pool.query('update contacts set tag_id = $1 where id = $2', [tag.id, contact.id]);

  const broadcast = await launchAudienceBroadcast(`${SUITE_PREFIX}camp2`, tag.id);
  assert.equal(broadcast.recipient_count, 1, 'the pre-existing tag_id path must be unaffected by this fix');
});

test('3. a contact with neither does not match', async () => {
  const tag = await createTag(`${SUITE_PREFIX}Untagged_${Date.now()}`);
  await createContact(`${SUITE_PREFIX}NoTagAtAll`, `9172${String(Date.now()).slice(-8)}`);

  const broadcast = await launchAudienceBroadcast(`${SUITE_PREFIX}camp3`, tag.id);
  assert.equal(broadcast.recipient_count, 0);
});

test('4. the match is scoped per-tag, not "has any tag" — tag_id=X and contact_tags=Y on different contacts don\'t cross-match', async () => {
  const tagX = await createTag(`${SUITE_PREFIX}X_${Date.now()}`);
  const tagY = await createTag(`${SUITE_PREFIX}Y_${Date.now()}`);
  const contactPrimaryX = await createContact(`${SUITE_PREFIX}HasX`, `9173${String(Date.now()).slice(-8)}`);
  await pool.query('update contacts set tag_id = $1 where id = $2', [tagX.id, contactPrimaryX.id]);
  const contactMultiY = await createContact(`${SUITE_PREFIX}HasY`, `9174${String(Date.now()).slice(-8)}`);
  await fetch(`${baseUrl}/api/contacts/${contactMultiY.id}/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ tagId: tagY.id }) });

  const broadcastX = await launchAudienceBroadcast(`${SUITE_PREFIX}campX`, tagX.id);
  assert.equal(broadcastX.recipient_count, 1);
  const xRecipients = await pool.query('select contact_id from broadcast_recipients where broadcast_id = $1', [broadcastX.id]);
  assert.deepEqual(xRecipients.rows.map((r) => r.contact_id), [contactPrimaryX.id]);

  const broadcastY = await launchAudienceBroadcast(`${SUITE_PREFIX}campY`, tagY.id);
  assert.equal(broadcastY.recipient_count, 1);
  const yRecipients = await pool.query('select contact_id from broadcast_recipients where broadcast_id = $1', [broadcastY.id]);
  assert.deepEqual(yRecipients.rows.map((r) => r.contact_id), [contactMultiY.id]);
});
