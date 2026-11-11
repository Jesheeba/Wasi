// Migration 090_messages_api_key_id.js - a real admin investigation
// (2026-11-11) into a 10:24 IST send to Sirah Digital could only identify
// which app sent it ("Auratel") by correlating messages.sent_at against
// api_keys.last_used_at to the millisecond; neither the client dashboard nor
// the admin panel could show it, because messages never recorded which Hub
// API key sent them at all.
//
// This covers the full path: POST /api/v1/messages stamps the caller's own
// api_key_id on the outbound row; GET /api/chats/:id/messages (the client's
// own inbox) surfaces it as sent_via_app; GET /api/admin/clients/:id (the
// admin panel) surfaces it both per-key (apiKeys) and per-send
// (hubApiActivity); and the webhook-forward destructure in metaWebhook.js
// never leaks it externally.
//
// Own dedicated disposable test client. Every Meta call is stubbed - no
// real send.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const { encrypt } = require('../src/utils/encryption');

let server, baseUrl, clientToken, testClientId, adminToken, apiKey, chatId, phone;

const SUITE_PREFIX = '__test_suite__msgapikey_';

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
      email: `test-suite-msgapikey-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: require('./helpers/adminCredentials').ADMIN_PASSWORD }),
  }).then((r) => r.json());
  adminToken = adminLogin.token;
  assert.ok(adminToken, 'demo admin login must succeed - run `npm run db:seed` first');

  const created = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST',
    headers: authed(adminToken),
    body: JSON.stringify({ client_id: testClientId, app_name: `${SUITE_PREFIX}Auratel` }),
  }).then((r) => r.json());
  apiKey = created.key;
  assert.ok(apiKey, 'api key creation via the admin route must succeed');

  await wabasRepo.upsertForClient(testClientId, {
    waba_id: `${SUITE_PREFIX}waba`,
    phone_number_id: `${SUITE_PREFIX}phone`,
    status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });

  phone = `9168${Date.now()}`.slice(0, 12);
  const contact = await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: 'Attribution Test Contact', wa_id: phone });
  const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
  chatId = chat.id;
  // Open the 24h freeform window - sendChatMessage's canSendFreeform check.
  await chatsRepo.insertInbound(pool, testClientId, chat.id, {
    metaMessageId: `wamid.${SUITE_PREFIX}setup_${Date.now()}`, body: 'hi', sentAt: new Date().toISOString(),
  });
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('a Hub API text send stamps api_key_id, and the client inbox surfaces it as sent_via_app', async () => {
  const keysBefore = await fetch(`${baseUrl}/api/admin/api-keys?clientId=${testClientId}`, { headers: authed(adminToken) }).then((r) => r.json());
  const keyRecord = keysBefore.find((k) => k.app_name === `${SUITE_PREFIX}Auratel`);
  assert.ok(keyRecord, 'the key must be listed by admin before any send');

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${SUITE_PREFIX}sent` }] }) };
  };

  let sent;
  try {
    const sendRes = await fetch(`${baseUrl}/api/v1/messages`, {
      method: 'POST', headers: authed(apiKey),
      body: JSON.stringify({ client_id: testClientId, to: phone, type: 'text', body: 'your code is 482913' }),
    });
    sent = await sendRes.json();
    assert.equal(sendRes.status, 201, JSON.stringify(sent));
  } finally {
    global.fetch = originalFetch;
  }

  // Direct DB check: the row actually has api_key_id set to the key that
  // made the call.
  const { rows } = await pool.query('select api_key_id from messages where id = $1', [sent.id]);
  assert.equal(rows[0].api_key_id, keyRecord.id, 'stored api_key_id must be the key that made the call');

  // The client's own inbox (GET /api/chats/:id/messages) must show which
  // app sent it - not just that it happened.
  const messagesRes = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, { headers: authed(clientToken) });
  const messages = await messagesRes.json();
  const outbound = messages.find((m) => m.direction === 'out');
  assert.ok(outbound, 'the send must appear in the chat history');
  assert.equal(outbound.sent_via_app, `${SUITE_PREFIX}Auratel`);
});

test('the admin client-detail route surfaces the key (apiKeys) and the send itself (hubApiActivity)', async () => {
  const keysRes = await fetch(`${baseUrl}/api/admin/api-keys?clientId=${testClientId}`, { headers: authed(adminToken) });
  const keys = await keysRes.json();
  const apiKeyRecord = keys.find((k) => k.app_name === `${SUITE_PREFIX}Auratel`);
  assert.ok(apiKeyRecord, 'the key must be listed by admin');
  assert.ok(apiKeyRecord.last_used_at, 'last_used_at must be stamped after the send');

  const detailRes = await fetch(`${baseUrl}/api/admin/clients/${testClientId}`, { headers: authed(adminToken) });
  const detail = await detailRes.json();

  assert.ok(Array.isArray(detail.apiKeys), 'admin client detail must include apiKeys');
  assert.ok(detail.apiKeys.some((k) => k.app_name === `${SUITE_PREFIX}Auratel`));

  assert.ok(Array.isArray(detail.hubApiActivity), 'admin client detail must include hubApiActivity');
  const activity = detail.hubApiActivity.find((m) => m.sent_via_app === `${SUITE_PREFIX}Auratel`);
  assert.ok(activity, 'the send must appear in hubApiActivity');
  assert.equal(activity.contact_phone, phone);
  assert.equal(activity.status, 'sent');
});

test('the webhook-forward payload never leaks api_key_id', async () => {
  // Static check, matching this codebase's own convention
  // (CLAUDE.md: "every messages column must be checked against
  // metaWebhook.js's enqueueForwards destructure") - a real inbound-forward
  // integration test already asserts the full forwarded key set elsewhere
  // (webhookForwarding.test.js); this confirms the exclusion itself exists.
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../src/routes/metaWebhook.js'), 'utf8');
  assert.match(src, /api_key_id:\s*_apiKeyId/, 'metaWebhook.js must explicitly exclude api_key_id from the forwarded message payload');
});
