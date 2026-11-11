// Fixes a real bug reported live (2026-11-11, Leaders Connect): a template
// showed "approved" locally while Meta still showed it pending/rejected.
// Root cause: routes/metaWebhook.js's handleTemplateStatusUpdate matched a
// message_template_status_update event only by (name, client_id) - no
// language, no meta_template_id - so an approval of ONE language variant of
// a template flipped every row sharing that name, client-wide. Meta scopes
// a template to (name, language) per WABA (messageTemplatesRepo.js's own
// findActiveByNameAndLanguage comment), so this is a real cross-language
// leak, not a timing issue. Fixed to match by meta_template_id first, then
// (name, language), only falling back to name-alone (logged) if neither is
// present on the payload. Dedicated test client + a fake waba_id, same
// pattern as webhookForwarding.test.js - this WABA is never given a real
// access token, so nothing here can reach a real phone or a real Meta call.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const messageTemplatesRepo = require('../src/repositories/messageTemplatesRepo');

let server;
let baseUrl;
let testClientId;

const SUITE_PREFIX = '__test_suite__tmpl_status_';
const TEST_WABA_ID = 'test_suite_tmpl_status_waba_id';

function signedMetaPost(payload) {
  const body = JSON.stringify(payload);
  const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
  return fetch(`${baseUrl}/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
}

function statusUpdatePayload(overrides) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: TEST_WABA_ID,
      changes: [{
        field: 'message_template_status_update',
        value: {
          event: 'APPROVED',
          message_template_name: `${SUITE_PREFIX}promo`,
          ...overrides,
        },
      }],
    }],
  };
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
      email: `test-suite-tmpl-status-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  testClientId = registered.client?.id;
  assert.ok(testClientId, 'dedicated test client registration must succeed');

  await wabasRepo.upsertForClient(testClientId, {
    waba_id: TEST_WABA_ID,
    phone_number_id: 'test_suite_tmpl_status_phone_id',
    display_phone_number: '917339561632',
    status: 'connected',
  });
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function waitFor(check, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - start >= timeoutMs) throw new Error('waitFor: condition not met within timeout');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('1. an APPROVED event for one language does not flip a different language variant of the same name', async () => {
  const en = await messageTemplatesRepo.create(pool, {
    client_id: testClientId, name: `${SUITE_PREFIX}promo`, category: 'Marketing',
    status: 'pending', body: 'Hello', language: 'en_US',
  });
  const ta = await messageTemplatesRepo.create(pool, {
    client_id: testClientId, name: `${SUITE_PREFIX}promo`, category: 'Marketing',
    status: 'pending', body: 'Vanakkam', language: 'ta',
  });

  const res = await signedMetaPost(statusUpdatePayload({ message_template_language: 'en_US' }));
  assert.equal(res.status, 200);

  const enRow = await waitFor(async () => {
    const r = await pool.query('select status from message_templates where id = $1', [en.id]);
    return r.rows[0]?.status === 'approved' ? r.rows[0] : null;
  });
  assert.equal(enRow.status, 'approved');

  const taRow = (await pool.query('select status from message_templates where id = $1', [ta.id])).rows[0];
  assert.equal(taRow.status, 'pending', 'the Tamil variant must be untouched by the English approval');
});

test('2. meta_template_id, when present, is preferred over name+language', async () => {
  const dup1 = await messageTemplatesRepo.create(pool, {
    client_id: testClientId, name: `${SUITE_PREFIX}dup`, category: 'Marketing',
    status: 'pending', body: 'A', language: 'en_US', meta_template_id: 'meta_id_dup_1',
  });

  const res = await signedMetaPost(statusUpdatePayload({
    message_template_name: `${SUITE_PREFIX}dup`,
    message_template_id: 'meta_id_dup_1',
    message_template_language: 'en_US',
  }));
  assert.equal(res.status, 200);

  const row = await waitFor(async () => {
    const r = await pool.query('select status from message_templates where id = $1', [dup1.id]);
    return r.rows[0]?.status === 'approved' ? r.rows[0] : null;
  });
  assert.equal(row.status, 'approved');
});

test('3. a rejection clears to the right language only, and sets rejection_reason', async () => {
  const en = await messageTemplatesRepo.create(pool, {
    client_id: testClientId, name: `${SUITE_PREFIX}reject`, category: 'Marketing',
    status: 'pending', body: 'Hello', language: 'en_US',
  });
  const ta = await messageTemplatesRepo.create(pool, {
    client_id: testClientId, name: `${SUITE_PREFIX}reject`, category: 'Marketing',
    status: 'pending', body: 'Vanakkam', language: 'ta',
  });

  const res = await signedMetaPost({
    object: 'whatsapp_business_account',
    entry: [{
      id: TEST_WABA_ID,
      changes: [{
        field: 'message_template_status_update',
        value: {
          event: 'REJECTED',
          reason: 'INCORRECT_CATEGORY',
          message_template_name: `${SUITE_PREFIX}reject`,
          message_template_language: 'ta',
        },
      }],
    }],
  });
  assert.equal(res.status, 200);

  const taRow = await waitFor(async () => {
    const r = await pool.query('select status, rejection_reason from message_templates where id = $1', [ta.id]);
    return r.rows[0]?.status === 'rejected' ? r.rows[0] : null;
  });
  assert.equal(taRow.status, 'rejected');
  assert.equal(taRow.rejection_reason, 'INCORRECT_CATEGORY');

  const enRow = (await pool.query('select status from message_templates where id = $1', [en.id])).rows[0];
  assert.equal(enRow.status, 'pending', 'the English variant must be untouched by the Tamil rejection');
});
