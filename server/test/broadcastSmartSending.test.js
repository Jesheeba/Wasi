// PLAN.md item 12 — Smart Sending, anti-duplicate broadcast spacing.
// Verifies:
// 1. Two broadcasts with smartSendingHours set, same target contact,
//    launched within the window — the second send is skipped with
//    error_reason: 'smart_sending_window', never reaching the Cloud API
//    (proven by the fetch stub never being called for that recipient's
//    send, not just by the final DB status).
// 2. Without smartSendingHours set, both broadcasts send normally to the
//    same contact — the feature is genuinely opt-in, not a silent default.
// 3. hasRecentSend only counts a REAL 'sent' row (a skipped/failed prior
//    attempt must not itself count as "recently received").
// 4. Smart Sending checks client-wide (any other campaign), not just
//    "this same broadcast twice" (which can't happen anyway — one
//    campaign never targets one contact twice).
// Same dedicated-disposable-test-client + Meta-boundary-only fetch-faking
// pattern as broadcastPacing.test.js/broadcastPauseResume.test.js — a real
// Utility-category template sidesteps the consent gate, which is already
// covered elsewhere.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const broadcastRunner = require('../src/services/broadcastRunner');
const broadcastRecipientsRepo = require('../src/repositories/broadcastRecipientsRepo');
const broadcastsRepo = require('../src/repositories/broadcastsRepo');
const { encrypt } = require('../src/utils/encryption');

let server, baseUrl, clientToken, testClientId, originalFetch;
let sendCallCount;

const SUITE_PREFIX = '__test_suite__smartsending_';
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
      email: `test-suite-smartsending-${Date.now()}@wasi.local`,
      password: PASSWORD,
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  await wabasRepo.upsertForClient(testClientId, {
    waba_id: `${SUITE_PREFIX}waba`,
    phone_number_id: `${SUITE_PREFIX}phone`,
    status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(() => { originalFetch = global.fetch; sendCallCount = 0; });
afterEach(() => { global.fetch = originalFetch; });

function stubMetaFetch() {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (!String(url).includes('graph.facebook.com')) return realFetch(url, opts);
    if (String(url).endsWith('/messages')) {
      sendCallCount++;
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${Date.now()}.${Math.random()}` }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_template_id`, status: 'APPROVED', category: 'UTILITY' }) };
  };
}

async function createRealTemplate() {
  const templateName = `${SUITE_PREFIX}tpl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const res = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      name: templateName, category: 'Utility',
      body: 'Hi {{customer_name}}, this is a real smart sending test message.',
      bodyParamExamples: { customer_name: 'Test' },
    }),
  });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return templateName;
}

// tagId here sets contacts.tag_id (the single primary tag) directly at
// creation — createFromAudience (used for a tag_id-based broadcast) filters
// on that column specifically, NOT item 8's additive contact_tags table
// (a real mistake this test's first draft made, caught by 0 recipients
// ever being claimed to send at all).
async function createContact(name, phone, tagId) {
  return fetch(`${baseUrl}/api/contacts`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name, phone, tag_id: tagId }) }).then((r) => r.json());
}

async function launchBroadcast({ title, tagId, templateName, smartSendingHours }) {
  return fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      title, tag_id: tagId, templateName,
      paramMappings: { customer_name: { source: 'contact_field', field: 'name' } },
      smartSendingHours,
    }),
  }).then((r) => r.json());
}

test('1. within the window: the second broadcast\'s send to the same contact is skipped, never reaching the Cloud API', async () => {
  stubMetaFetch();
  const ts = String(Date.now()).slice(-9);
  const tagRes = await fetch(`${baseUrl}/api/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name: `${SUITE_PREFIX}tag1_${ts}` }) }).then((r) => r.json());
  const contact = await createContact(`${SUITE_PREFIX}Contact1`, `919${ts}1`, tagRes.id);

  const templateName = await createRealTemplate();

  const first = await launchBroadcast({ title: `${SUITE_PREFIX}first`, tagId: tagRes.id, templateName, smartSendingHours: 24 });
  await broadcastRunner.processBroadcast(await broadcastsRepo.findById(pool, testClientId, first.id));
  assert.equal(sendCallCount, 1, 'the first broadcast must actually send');

  const second = await launchBroadcast({ title: `${SUITE_PREFIX}second`, tagId: tagRes.id, templateName, smartSendingHours: 24 });
  await broadcastRunner.processBroadcast(await broadcastsRepo.findById(pool, testClientId, second.id));
  assert.equal(sendCallCount, 1, 'the second broadcast must NOT call the Cloud API for a contact already recently sent to');

  const recipient = await pool.query(`select status, error_reason from broadcast_recipients where broadcast_id = $1 and contact_id = $2`, [second.id, contact.id]);
  assert.equal(recipient.rows[0].status, 'skipped');
  assert.equal(recipient.rows[0].error_reason, 'smart_sending_window');

  // Real bug, fixed: this skip used to be counted under skipped_consent_count
  // with no way to tell it apart from a real consent skip. Now reported
  // under its own field, and NOT counted as a consent skip.
  const [listed] = await fetch(`${baseUrl}/api/broadcasts`, { headers: authed(clientToken) })
    .then((r) => r.json())
    .then((list) => list.filter((b) => b.id === second.id));
  assert.equal(listed.skipped_smart_sending_count, 1);
  assert.equal(listed.skipped_consent_count, 0, 'a smart-sending skip must never be counted as a consent skip');
});

test('2. without smartSendingHours set, both broadcasts send normally to the same contact', async () => {
  stubMetaFetch();
  const ts = String(Date.now()).slice(-9);
  const tagRes = await fetch(`${baseUrl}/api/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name: `${SUITE_PREFIX}tag2_${ts}` }) }).then((r) => r.json());
  const contact = await createContact(`${SUITE_PREFIX}Contact2`, `919${ts}2`, tagRes.id);
  const templateName = await createRealTemplate();

  const first = await launchBroadcast({ title: `${SUITE_PREFIX}first2`, tagId: tagRes.id, templateName });
  await broadcastRunner.processBroadcast(await broadcastsRepo.findById(pool, testClientId, first.id));

  const second = await launchBroadcast({ title: `${SUITE_PREFIX}second2`, tagId: tagRes.id, templateName });
  await broadcastRunner.processBroadcast(await broadcastsRepo.findById(pool, testClientId, second.id));

  assert.equal(sendCallCount, 2, 'both broadcasts must send when Smart Sending is not enabled');
  const statuses = await pool.query(`select status from broadcast_recipients where broadcast_id = any($1::uuid[]) and contact_id = $2`, [[first.id, second.id], contact.id]);
  assert.ok(statuses.rows.every((r) => r.status === 'sent'));
});

test('3. hasRecentSend only counts a real \'sent\' row — a skipped/failed prior attempt does not itself count', async () => {
  const ts = String(Date.now()).slice(-9);
  const contact = await createContact(`${SUITE_PREFIX}Contact3`, `919${ts}3`);

  const broadcastRow = await pool.query(
    `insert into broadcasts (client_id, title, template_name, status, param_mappings) values ($1, 'x', 't', 'Sending', '{}') returning id`,
    [testClientId]
  ).then((r) => r.rows[0]);
  await pool.query(
    `insert into broadcast_recipients (broadcast_id, client_id, contact_id, status, error_reason) values ($1, $2, $3, 'skipped', 'consent_required')`,
    [broadcastRow.id, testClientId, contact.id]
  );

  const recent = await broadcastRecipientsRepo.hasRecentSend(pool, testClientId, contact.id, 24);
  assert.equal(recent, false, 'a skipped (never actually sent) row must not count as a recent send');
});

test('4. checks client-wide across ANY broadcast, not just the same one', async () => {
  const ts = String(Date.now()).slice(-9);
  const contact = await createContact(`${SUITE_PREFIX}Contact4`, `919${ts}4`);
  const chat = await pool.query(`insert into chats (client_id, contact_id, name, phone) values ($1, $2, 'x', $3) returning id`, [testClientId, contact.id, `919${ts}4`]).then((r) => r.rows[0]);
  const message = await pool.query(`insert into messages (chat_id, client_id, direction, body, sent_at) values ($1, $2, 'out', 'x', now()) returning id`, [chat.id, testClientId]).then((r) => r.rows[0]);
  const broadcastA = await pool.query(`insert into broadcasts (client_id, title, template_name, status, param_mappings) values ($1, 'campaign A', 't', 'Sending', '{}') returning id`, [testClientId]).then((r) => r.rows[0]);
  await pool.query(`insert into broadcast_recipients (broadcast_id, client_id, contact_id, message_id, status) values ($1, $2, $3, $4, 'sent')`, [broadcastA.id, testClientId, contact.id, message.id]);

  // Asking about a DIFFERENT (as yet nonexistent) broadcast B — the recent
  // send came from campaign A entirely, proving the check is client-wide.
  const recent = await broadcastRecipientsRepo.hasRecentSend(pool, testClientId, contact.id, 24);
  assert.equal(recent, true, 'a recent send from a different campaign must still count');
});
