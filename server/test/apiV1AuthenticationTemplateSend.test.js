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

test('extractAuthenticationCode accepts exactly one non-empty string or finite number, rejects everything else with a reason', () => {
  assert.deepEqual(metaClient.extractAuthenticationCode({ code: '482913' }), { code: '482913' });
  assert.deepEqual(metaClient.extractAuthenticationCode({ otp: 123456 }), { code: '123456' });
  assert.deepEqual(metaClient.extractAuthenticationCode({ code: 0 }), { code: '0' });

  assert.match(metaClient.extractAuthenticationCode({ code: 'AAA', 1: 'BBB' }).error, /exactly one parameter.*received 2/);
  assert.match(metaClient.extractAuthenticationCode({}).error, /received 0/);
  assert.match(metaClient.extractAuthenticationCode(undefined).error, /received 0/);
  assert.match(metaClient.extractAuthenticationCode(['123456']).error, /received 0/);
  for (const bad of [null, undefined, true, false, {}, ['1'], '', '   ', NaN, Infinity]) {
    assert.match(metaClient.extractAuthenticationCode({ code: bad }).error, /^code must be a non-empty string or number/, `value ${String(bad)}`);
  }
});

test('Authentication template sends: valid codes reach Meta as body + button; every invalid request is rejected before Meta', async () => {
  const originalFetch = global.fetch;
  const sendRequests = [];
  // Stubbed BEFORE template creation too — creating the template calls
  // Meta's real create endpoint (see apiV1MessageLanguage.test.js).
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    if (String(url).endsWith('/messages')) {
      sendRequests.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${SUITE_PREFIX}sent_${sendRequests.length}` }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_template_id`, status: 'APPROVED', category: 'AUTHENTICATION' }) };
  };

  const expectedComponents = (code) => [
    { type: 'body', parameters: [{ type: 'text', text: code }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
  ];

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

    // `params` omitted entirely when undefined (JSON.stringify drops the key).
    async function send(params) {
      const res = await fetch(`${baseUrl}/api/v1/messages`, {
        method: 'POST', headers: authed(apiKey),
        body: JSON.stringify({ client_id: testClientId, to: phone, type: 'template', template: templateName, params }),
      });
      return { status: res.status, data: await res.json() };
    }

    // --- accepted ---
    const ok = await send({ code: '482913' });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(sendRequests.length, 1);
    assert.deepEqual(sendRequests[0].template.components, expectedComponents('482913'));

    const num = await send({ code: 123456 });
    assert.equal(num.status, 201, JSON.stringify(num.data));
    assert.equal(sendRequests.length, 2);
    assert.deepEqual(sendRequests[1].template.components, expectedComponents('123456'), 'a number is sent as the string "123456"');

    // --- rejected: none may reach Meta ---
    const rejected = [
      ['two keys (string key + integer-like key)', { code: 'AAA', 1: 'BBB' }, /exactly one parameter.*received 2/],
      ['null value', { code: null }, /code must be a non-empty string or number/],
      ['empty object', {}, /received 0/],
      ['params omitted', undefined, /received 0/],
      ['empty string', { code: '' }, /code must be a non-empty string or number/],
      ['boolean', { code: true }, /code must be a non-empty string or number/],
      ['object', { code: { a: 1 } }, /code must be a non-empty string or number/],
      ['array', { code: ['1'] }, /code must be a non-empty string or number/],
      ['16-character code', { code: 'ABCDEFGHIJKLMNOP' }, /16 characters.*at most 15/],
    ];
    for (const [label, params, messagePattern] of rejected) {
      const r = await send(params);
      assert.equal(r.status, 409, `${label}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.error.code, 'auth_code_invalid', label);
      assert.match(r.data.error.message, messagePattern, label);
    }
    assert.equal(sendRequests.length, 2, 'no rejected request may reach Meta');

    // A 15-character code is the boundary and is accepted.
    const boundary = await send({ code: 'ABCDEFGHIJKLMNO' });
    assert.equal(boundary.status, 201, JSON.stringify(boundary.data));
    assert.equal(sendRequests.length, 3);
  } finally {
    global.fetch = originalFetch;
  }
});
