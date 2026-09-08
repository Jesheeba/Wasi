// PLAN.md item 14 — CTWA (Click-to-WhatsApp ad) referral capture. Verifies,
// against a SIMULATED webhook payload only (matching §6.2's documented real
// shape, constructed as test fixture data — never real ad traffic, per
// explicit instruction):
// 1. An inbound message carrying Meta's referral object lands in
//    messages.referral verbatim.
// 2. An inbound message with NO referral (the ordinary case) stores null —
//    this feature must never invent attribution for organic contacts.
// 3. It surfaces correctly in GET /api/analytics/ctwa, grouped by
//    (source_id, headline), with an unrelated (no-referral) message never
//    polluting the count.
// 4. It surfaces in item 10's Contact 360 timeline's message_in detail.
// No verification against real ad traffic is performed here — that is
// explicitly pending on the plan owner's side, per instruction.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');

let server, baseUrl, clientToken, testClientId;

const SUITE_PREFIX = '__test_suite__msgreferral_';
const TEST_WABA_ID = `${SUITE_PREFIX}waba`;
const TEST_PHONE_NUMBER_ID = `${SUITE_PREFIX}phone`;

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function postWebhook(payloadEntry) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: TEST_WABA_ID, changes: [{ field: 'messages', value: payloadEntry }] }],
  };
  const body = JSON.stringify(payload);
  const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
  return fetch(`${baseUrl}/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
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
      email: `test-suite-msgreferral-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  await wabasRepo.upsertForClient(testClientId, { waba_id: TEST_WABA_ID, status: 'connected' });
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('1-2. an inbound message with a referral object stores it verbatim; one with no referral stores null', async () => {
  const phoneWithReferral = `9195${Date.now()}`.slice(0, 12);
  const referral = {
    source_url: 'https://fb.me/ad123',
    source_type: 'ad',
    source_id: `${SUITE_PREFIX}source_1`,
    headline: 'Summer Sale',
    body: 'Get 20% off',
    media_type: 'image',
    image_url: 'https://example.com/ad.jpg',
    ctwa_clid: `${SUITE_PREFIX}clid_1`,
  };
  const res1 = await postWebhook({
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '917339561631', phone_number_id: TEST_PHONE_NUMBER_ID },
    contacts: [{ wa_id: phoneWithReferral, profile: { name: 'Ad Contact' } }],
    messages: [{
      from: phoneWithReferral, id: `wamid.${SUITE_PREFIX}withref_${Date.now()}`, type: 'text',
      text: { body: 'Hi, interested in the sale' }, timestamp: '1786973208', referral,
    }],
  });
  assert.equal(res1.status, 200);

  const phoneOrganic = `9196${Date.now()}`.slice(0, 12);
  const res2 = await postWebhook({
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '917339561631', phone_number_id: TEST_PHONE_NUMBER_ID },
    contacts: [{ wa_id: phoneOrganic, profile: { name: 'Organic Contact' } }],
    messages: [{ from: phoneOrganic, id: `wamid.${SUITE_PREFIX}organic_${Date.now()}`, type: 'text', text: { body: 'Hello' }, timestamp: '1786973300' }],
  });
  assert.equal(res2.status, 200);

  const withRefRow = await pool.query(
    `select m.referral from messages m join contacts c on c.id = (select contact_id from chats where id = m.chat_id) where c.phone = $1`,
    [phoneWithReferral]
  );
  assert.deepEqual(withRefRow.rows[0].referral, referral);

  const organicRow = await pool.query(
    `select m.referral from messages m join contacts c on c.id = (select contact_id from chats where id = m.chat_id) where c.phone = $1`,
    [phoneOrganic]
  );
  assert.equal(organicRow.rows[0].referral, null, 'an ordinary organic message must never invent attribution data');
});

test('3. surfaces in GET /api/analytics/ctwa, grouped by (source_id, headline), unaffected by a no-referral message', async () => {
  const res = await fetch(`${baseUrl}/api/analytics/ctwa`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const { bySource } = await res.json();
  const row = bySource.find((r) => r.sourceId === `${SUITE_PREFIX}source_1`);
  assert.ok(row, 'the referral-sourced message must appear in the aggregate');
  assert.equal(row.headline, 'Summer Sale');
  assert.equal(row.messageCount, 1, 'the organic (no-referral) message from test 1-2 must not be counted here');
});

test('4. surfaces in item 10\'s Contact 360 timeline\'s message_in detail', async () => {
  const phoneWithReferral = (await pool.query(
    `select c.phone from messages m join contacts c on c.id = (select contact_id from chats where id = m.chat_id) where m.referral->>'source_id' = $1`,
    [`${SUITE_PREFIX}source_1`]
  )).rows[0].phone;
  const contactRow = await pool.query('select id from contacts where client_id = $1 and phone = $2', [testClientId, phoneWithReferral]);
  const contactId = contactRow.rows[0].id;

  const res = await fetch(`${baseUrl}/api/contacts/${contactId}/timeline`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const { events } = await res.json();
  const messageInEvent = events.find((e) => e.type === 'message_in');
  assert.ok(messageInEvent);
  assert.ok(messageInEvent.detail.referral, 'the timeline\'s message_in detail must include the referral object when present');
  assert.equal(messageInEvent.detail.referral.source_id, `${SUITE_PREFIX}source_1`);
});
