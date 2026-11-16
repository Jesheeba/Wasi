// Limited-Time-Offer templates (build-docs/features/limited-time-offer-templates.md)
// - the coupon/countdown strip Meta's Marketing templates support, missing
// from this app entirely before this feature (confirmed by grep: zero
// `LIMITED_TIME_OFFER` references anywhere in metaClient.js/validate.js).
// Own dedicated disposable test client (same pattern as
// apiV1AuthenticationTemplateSend.test.js); every Meta call is stubbed - no
// real send.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const messageTemplatesRepo = require('../src/repositories/messageTemplatesRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const consentRepo = require('../src/repositories/consentRepo');
const { encrypt } = require('../src/utils/encryption');

let server, baseUrl, clientToken, testClientId, adminToken, apiKey;

const SUITE_PREFIX = '__test_suite__ltotemplates_';

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
      email: `test-suite-ltotemplates-${Date.now()}@wasi.local`,
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

// --- Creation: local rejections, no Meta call ---

test('POST /api/templates: a limited-time offer alongside a non-NONE header is rejected locally (400), no Meta call made', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('graph.facebook.com')) throw new Error('must not call Meta - rejected before that point');
    return originalFetch(url, options);
  };
  try {
    const res = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST', headers: authed(clientToken),
      body: JSON.stringify({
        name: `${SUITE_PREFIX}lto_with_header`, category: 'Marketing', language: 'en_US',
        body: 'Flash sale this weekend!', header: { type: 'TEXT', text: 'Sale!' },
        limitedTimeOffer: { text: 'Flash Sale!', code: '25OFF', hasExpiration: true },
      }),
    });
    assert.equal(res.status, 400);
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/templates: offer text over 16 characters is rejected locally (400)', async () => {
  const res = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      name: `${SUITE_PREFIX}lto_text_too_long`, category: 'Marketing', language: 'en_US',
      body: 'Flash sale this weekend!',
      limitedTimeOffer: { text: 'This offer text is way too long', code: '25OFF', hasExpiration: true },
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/templates: coupon code over 15 characters is rejected locally (400)', async () => {
  const res = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      name: `${SUITE_PREFIX}lto_code_too_long`, category: 'Marketing', language: 'en_US',
      body: 'Flash sale this weekend!',
      limitedTimeOffer: { text: 'Flash Sale!', code: 'THIS-CODE-IS-WAY-TOO-LONG', hasExpiration: true },
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/templates: a limited-time offer with no coupon code is rejected locally (400)', async () => {
  const res = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      name: `${SUITE_PREFIX}lto_no_code`, category: 'Marketing', language: 'en_US',
      body: 'Flash sale this weekend!',
      limitedTimeOffer: { text: 'Flash Sale!', hasExpiration: true },
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/templates: a limited-time offer alongside a footer is rejected locally (400), no Meta call made', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('graph.facebook.com')) throw new Error('must not call Meta - rejected before that point');
    return originalFetch(url, options);
  };
  try {
    const res = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST', headers: authed(clientToken),
      body: JSON.stringify({
        name: `${SUITE_PREFIX}lto_with_footer`, category: 'Marketing', language: 'en_US',
        body: 'Flash sale this weekend!', footer: 'Reply STOP to unsubscribe',
        limitedTimeOffer: { text: 'Flash Sale!', code: '25OFF', hasExpiration: true },
      }),
    });
    assert.equal(res.status, 400);
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/templates: a limited-time offer on a non-Marketing category is rejected locally (400)', async () => {
  const res = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      name: `${SUITE_PREFIX}lto_wrong_category`, category: 'Utility', language: 'en_US',
      body: 'Your order has shipped!',
      limitedTimeOffer: { text: 'Flash Sale!', code: '25OFF', hasExpiration: true },
    }),
  });
  assert.equal(res.status, 400);
});

// --- Creation: real success path ---

test('POST /api/templates: a valid Marketing + limited-time-offer template (no header) submits to Meta with a LIMITED_TIME_OFFER component', async () => {
  const originalFetch = global.fetch;
  let createRequestBody = null;
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    createRequestBody = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_template_id`, status: 'PENDING', category: 'MARKETING' }) };
  };
  try {
    const res = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST', headers: authed(clientToken),
      body: JSON.stringify({
        name: `${SUITE_PREFIX}flash_sale`, category: 'Marketing', language: 'en_US',
        body: 'Flash sale this weekend - everything must go!',
        limitedTimeOffer: { text: 'Flash Sale!', code: '25OFF', hasExpiration: true },
      }),
    });
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
    const template = await res.json();

    assert.deepEqual(
      createRequestBody.components.find((c) => c.type === 'LIMITED_TIME_OFFER'),
      { type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: 'Flash Sale!', has_expiration: true } }
    );
    // Confirmed live against Meta (2026-11-16): a COPY_CODE button at
    // index 0 is REQUIRED alongside LIMITED_TIME_OFFER, not optional -
    // Meta rejects the template otherwise ("COPY_CODE is required at
    // index 0 when Limited Time Offer is present"). Its example must be
    // the literal code, not the strip's marketing text (also confirmed
    // live: Meta rejects a sentence-like example as invalid).
    assert.deepEqual(
      createRequestBody.components.find((c) => c.type === 'BUTTONS'),
      { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: '25OFF' }] }
    );

    const fromDb = await messageTemplatesRepo.findById(pool, testClientId, template.id);
    assert.deepEqual(fromDb.limited_time_offer, { text: 'Flash Sale!', code: '25OFF', hasExpiration: true });
  } finally {
    global.fetch = originalFetch;
  }
});

// --- Send time ---

test('sending a limited-time-offer template with hasExpiration requires limitedTimeOfferExpirationMs and forwards it to Meta', async () => {
  const originalFetch = global.fetch;
  const sendRequests = [];
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    if (String(url).endsWith('/messages')) {
      sendRequests.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${SUITE_PREFIX}sent_${sendRequests.length}` }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_template_id_2`, status: 'APPROVED', category: 'MARKETING' }) };
  };
  try {
    const templateName = `${SUITE_PREFIX}send_flash_sale_${Date.now()}`;
    const templateRes = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST', headers: authed(clientToken),
      body: JSON.stringify({
        name: templateName, category: 'Marketing', language: 'en_US',
        body: 'Flash sale - today only!',
        limitedTimeOffer: { text: 'Flash Sale!', code: '25OFF', hasExpiration: true },
      }),
    });
    assert.equal(templateRes.status, 201, JSON.stringify(await templateRes.clone().json()));

    const phone = `9168${Date.now()}`.slice(0, 12);
    const contact = await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: 'LTO Test Contact', wa_id: phone });
    const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
    // A Marketing template needs the consent gate to pass before reaching
    // the limited-time-offer check this test is actually about - otherwise
    // every send is rejected one check earlier (consent_required), for a
    // reason unrelated to what's being tested here.
    await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_in', source: 'test' });

    async function send(body) {
      const res = await fetch(`${baseUrl}/api/v1/messages`, {
        method: 'POST', headers: authed(apiKey),
        body: JSON.stringify({ client_id: testClientId, to: phone, type: 'template', template: templateName, ...body }),
      });
      return { status: res.status, data: await res.json() };
    }

    // Missing expiry - rejected before any Meta send call.
    const missing = await send({});
    assert.equal(missing.status, 409, JSON.stringify(missing.data));
    assert.equal(missing.data.error.code, 'limited_time_offer_expiration_required');
    assert.equal(sendRequests.length, 0);

    // Valid expiry - forwarded to Meta exactly as given.
    const expiry = Date.now() + 24 * 3600000;
    const ok = await send({ limitedTimeOfferExpirationMs: expiry });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(sendRequests.length, 1);
    assert.deepEqual(
      sendRequests[0].template.components.find((c) => c.type === 'limited_time_offer'),
      { type: 'limited_time_offer', parameters: [{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: expiry } }] }
    );
    // Confirmed live against Meta (2026-11-16): the copy_code button
    // component is required at send time too, alongside limited_time_offer.
    assert.deepEqual(
      sendRequests[0].template.components.find((c) => c.type === 'button' && c.sub_type === 'copy_code'),
      { type: 'button', sub_type: 'copy_code', index: '0', parameters: [{ type: 'coupon_code', coupon_code: '25OFF' }] }
    );

    void chat; // only needed to ensure the chat/contact exist for the send
  } finally {
    global.fetch = originalFetch;
  }
});
