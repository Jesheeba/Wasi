// Real bug, reported by an integrating developer (2026-09-21): sending an
// Authentication (OTP / Copy code button) template through POST
// /api/v1/messages always failed against Meta with "(#131008) Required
// parameter is missing". Meta requires the one-time code TWICE for these
// templates — once as the body parameter, once as the Copy code button's
// parameter — and Wasi only ever sent the body (as a *named* parameter, which
// Authentication's Meta-generated positional {{1}} body doesn't take either).
// Fixed in messagingService.sendChatMessage: for a template whose category is
// Authentication, the code is lifted from the caller's params and re-emitted
// as Meta's required body + button pair (metaClient.buildAuthenticationSendComponents).
//
// Own dedicated disposable test client (same pattern as
// apiV1MessageLanguage.test.js). Every Meta call is stubbed — no real send.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const metaClient = require('../src/utils/metaClient');
const { encrypt } = require('../src/utils/encryption');

let server, baseUrl, clientToken, testClientId, adminToken, apiKey;

const SUITE_PREFIX = '__test_suite__apiv1authtpl_';

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
      email: `test-suite-apiv1authtpl-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: 'admin12345' }),
  }).then((r) => r.json());
  adminToken = adminLogin.token;
  assert.ok(adminToken, 'demo admin login must succeed — run `npm run db:seed` first');

  const created = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST',
    headers: authed(adminToken),
    body: JSON.stringify({ client_id: testClientId, app_name: `${SUITE_PREFIX}app` }),
  }).then((r) => r.json());
  apiKey = created.key;
  assert.ok(apiKey, 'api key creation via the admin route must succeed');

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

test('buildAuthenticationSendComponents emits the code in both the body and the Copy code button', () => {
  assert.deepEqual(metaClient.buildAuthenticationSendComponents('482913'), [
    { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] },
  ]);
});

test('an Authentication template send carries the code in body AND button; a missing code is rejected before reaching Meta', async () => {
  const originalFetch = global.fetch;
  const sendRequests = [];
  // Stubbed BEFORE template creation too — creating the template calls
  // Meta's real create endpoint (see apiV1MessageLanguage.test.js).
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    if (String(url).endsWith('/messages')) {
      sendRequests.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${SUITE_PREFIX}sent` }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_template_id`, status: 'APPROVED', category: 'AUTHENTICATION' }) };
  };

  let okRes, okData, missingRes, missingData, tooLongRes, tooLongData;
  try {
    const templateName = `${SUITE_PREFIX}otp_${Date.now()}`;
    const templateRes = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST', headers: authed(clientToken),
      body: JSON.stringify({ name: templateName, category: 'Authentication', language: 'en_US', codeExpirationMinutes: 10, addSecurityDisclaimer: true }),
    });
    assert.equal(templateRes.status, 201, JSON.stringify(await templateRes.clone().json()));

    const phone = `9167${Date.now()}`.slice(0, 12);
    const contact = await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: 'OTP Test Contact', wa_id: phone });
    const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
    await chatsRepo.insertInbound(pool, testClientId, chat.id, {
      metaMessageId: `wamid.${SUITE_PREFIX}setup_${Date.now()}`, body: 'hi', sentAt: new Date().toISOString(),
    });

    okRes = await fetch(`${baseUrl}/api/v1/messages`, {
      method: 'POST', headers: authed(apiKey),
      body: JSON.stringify({ client_id: testClientId, to: phone, type: 'template', template: templateName, params: { code: '482913' } }),
    });
    okData = await okRes.json();

    missingRes = await fetch(`${baseUrl}/api/v1/messages`, {
      method: 'POST', headers: authed(apiKey),
      body: JSON.stringify({ client_id: testClientId, to: phone, type: 'template', template: templateName }),
    });
    missingData = await missingRes.json();

    tooLongRes = await fetch(`${baseUrl}/api/v1/messages`, {
      method: 'POST', headers: authed(apiKey),
      body: JSON.stringify({ client_id: testClientId, to: phone, type: 'template', template: templateName, params: { code: '1234567890123456' } }),
    });
    tooLongData = await tooLongRes.json();
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(okRes.status, 201, JSON.stringify(okData));
  assert.equal(sendRequests.length, 1, 'only the valid send may reach Meta — the missing-code request must be rejected first');
  assert.deepEqual(sendRequests[0].template.components, [
    { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] },
  ]);

  assert.equal(missingRes.status, 409, JSON.stringify(missingData));
  assert.equal(missingData.error.code, 'auth_code_required');

  assert.equal(tooLongRes.status, 409, JSON.stringify(tooLongData));
  assert.equal(tooLongData.error.code, 'auth_code_invalid');
  assert.equal(sendRequests.length, 1, 'the over-length code must also be rejected before reaching Meta');
});
