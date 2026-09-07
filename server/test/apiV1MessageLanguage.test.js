// Real production bug, fixed: server/src/routes/apiV1Messages.js used to
// hardcode templateLanguage: 'en_US' for every Hub API template send,
// regardless of what language the template was actually approved under —
// Meta rejects a send whose language doesn't match the real approved
// (name, language) pair, so any client with a non-en_US template (found via
// a real, read-only production check: Sirah Digital and Wasi Demo Client
// each have one 'en'-language approved template) had every Hub API
// template send to that template silently fail against real Meta. Fixed:
// the route now looks up the template's real language from the local
// message_templates row (messageTemplatesRepo.findByNameAndClient, the
// same lookup routes/broadcasts.js already uses for this purpose) instead
// of guessing.
//
// Own dedicated disposable test client, not reused from apiV1.test.js —
// that file's own test ordering is explicitly documented as fragile
// (later tests depend on this shared client's plan-limit state carrying
// over from earlier ones), so this stays fully independent rather than
// risking that.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const { encrypt } = require('../src/utils/encryption');

let server, baseUrl, clientToken, testClientId, adminToken, apiKey;

const SUITE_PREFIX = '__test_suite__apiv1msglang_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
function apiAuthed(key) {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
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
      email: `test-suite-apiv1msglang-${Date.now()}@wasi.local`,
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

test('1. a template approved under a non-en_US language sends to Meta with that REAL language, not a hardcoded en_US', async () => {
  // Stubbed BEFORE any call that could reach Meta — template CREATION
  // (routes/templates.js's POST /) calls Meta's real create-template
  // endpoint too, not just the message send below. An earlier draft of
  // this test set the stub up after that call and a real unstubbed POST
  // reached graph.facebook.com for real (confirmed by a real Meta-shaped
  // OAuth rejection, with a real fbtrace_id, coming back) — a genuine
  // violation of "never call a Meta write endpoint," caught and fixed
  // immediately, not left in place.
  const originalFetch = global.fetch;
  let capturedSendRequest = null;
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    if (String(url).endsWith('/messages')) {
      capturedSendRequest = { url: String(url), body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${SUITE_PREFIX}sent` }] }) };
    }
    // Template-creation call (.../message_templates) — real shape per
    // metaClient.js's createMessageTemplate, not asserted on here.
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_template_id`, status: 'APPROVED', category: 'UTILITY' }) };
  };

  let res, data, template;
  try {
    const templateName = `${SUITE_PREFIX}tpl_${Date.now()}`;
    const templateRes = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST', headers: authed(clientToken),
      body: JSON.stringify({
        name: templateName, category: 'Utility', language: 'en',
        body: 'Hi {{customer_name}}, this is a real non-en_US Hub API send test message.',
        bodyParamExamples: { customer_name: 'Test' },
      }),
    });
    assert.equal(templateRes.status, 201, JSON.stringify(await templateRes.clone().json()));
    template = await templateRes.json();
    assert.equal(template.language, 'en', 'the template must actually be stored as language "en", not en_US, for this test to mean anything');

    const phone = `9165${Date.now()}`.slice(0, 12);
    const contact = await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: 'Lang Test Contact', wa_id: phone });
    const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
    await chatsRepo.insertInbound(pool, testClientId, chat.id, {
      metaMessageId: `wamid.${SUITE_PREFIX}setup_${Date.now()}`, body: 'hi', sentAt: new Date().toISOString(),
    });

    res = await fetch(`${baseUrl}/api/v1/messages`, {
      method: 'POST', headers: apiAuthed(apiKey),
      body: JSON.stringify({
        client_id: testClientId, to: phone, type: 'template', template: templateName,
        params: { customer_name: 'Test' },
      }),
    });
    data = await res.json();
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(res.status, 201, JSON.stringify(data));
  assert.ok(capturedSendRequest, 'the real Meta send must actually have been attempted');
  assert.equal(capturedSendRequest.body.template.language.code, 'en', 'the REAL approved language must be sent, not a hardcoded en_US');
});

test('2. a template with no local record 404s with a clear code, rather than guessing a language and risking the same silent-rejection bug again', async () => {
  const phone = `9166${Date.now()}`.slice(0, 12);
  const res = await fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST', headers: apiAuthed(apiKey),
    body: JSON.stringify({ client_id: testClientId, to: phone, type: 'template', template: `${SUITE_PREFIX}does_not_exist` }),
  });
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.error.code, 'template_not_found');
});
