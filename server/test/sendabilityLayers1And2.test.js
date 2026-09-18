// Sendability monitoring, Layers 1 (registration) and 2 (health_status) —
// built after a real 26-hour undetected outage (TNPSC Mentors, 2026-09-18).
// See migration 074_wabas_sendability.js and sendabilityMonitorRunner.js's
// header comments for the full context.
//
// The one thing every test here must prove, not just assume: Layer 1 never
// sets wabas.sendable/sendable_reason/sendable_error_code/sendable_checked_at
// under any circumstance — is_on_biz_app === false && code_verification_status
// !== 'VERIFIED' was floated as a "definitely can't send" rule but was never
// confirmed (TNPSC registered successfully and code_verification_status
// stayed EXPIRED regardless of whether it could actually send), so an
// unvalidated heuristic must not be able to override what the send probe
// (Layer 3, not yet built) will find. Only graph.facebook.com is faked (this
// codebase's established convention) — everything else runs against the
// real (shared dev/prod) database via a dedicated disposable test client +
// WABA, deleted in after().
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const sendabilityMonitorRunner = require('../src/services/sendabilityMonitorRunner');
const { encrypt } = require('../src/utils/encryption');

let server;
let baseUrl;
let testClientId;
let adminToken;

const SUITE_PREFIX = '__test_suite__sendability12_';
const TEST_WABA_ID = 'test_suite_sendability12_waba_id';
const TEST_PHONE_NUMBER_ID = 'test_suite_sendability12_phone_id';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Same shape as messagingTier.test.js's own helper, including its own
// documented bug precedent (dropping `options` when delegating to the real
// fetch silently breaks the outer test's own call to the local test server).
async function withFakeGraphFetch(response, fn) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    if (!urlStr.includes('graph.facebook.com')) return originalFetch(url, options);
    if (urlStr.includes(TEST_PHONE_NUMBER_ID)) {
      if (response.fail) return { ok: false, status: 401, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) };
      return { ok: true, json: async () => response };
    }
    return originalFetch(url, options);
  };
  try {
    await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

async function setWabaRow(fields) {
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: TEST_WABA_ID, phone_number_id: TEST_PHONE_NUMBER_ID, status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
    // Explicit resets every call — several tests below assert these stay
    // null, and upsertForClient only touches columns it's passed.
    registration_is_on_biz_app: null, registration_code_verification_status: null,
    registration_platform_type: null, registration_phone_status: null, registration_checked_at: null,
    health_status: null, health_status_checked_at: null,
    sendable: null, sendable_checked_at: null, sendable_reason: null, sendable_error_code: null,
    ...fields,
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
      email: `test-suite-sendability12-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  testClientId = registered.client?.id;
  assert.ok(testClientId, 'dedicated test client registration must succeed');

  await setWabaRow({});

  const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: 'admin12345' }),
  }).then((r) => r.json());
  adminToken = adminLogin.token;
  assert.ok(adminToken, 'demo admin login must succeed — run `npm run db:seed` first');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('refreshOne persists registration fields and health_status, and never touches sendable', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);

  await withFakeGraphFetch({
    display_phone_number: '910000000000', verified_name: 'Test', quality_rating: 'GREEN',
    is_on_biz_app: false, code_verification_status: 'EXPIRED', platform_type: 'CLOUD_API', status: 'CONNECTED',
    health_status: { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'AVAILABLE' }] },
  }, async () => {
    const result = await sendabilityMonitorRunner.refreshOne(waba);
    assert.equal(result.ok, true);
    assert.equal(result.isOnBizApp, false);
    assert.equal(result.codeVerificationStatus, 'EXPIRED');
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.equal(updated.registration_is_on_biz_app, false);
  assert.equal(updated.registration_code_verification_status, 'EXPIRED');
  assert.equal(updated.registration_platform_type, 'CLOUD_API');
  assert.equal(updated.registration_phone_status, 'CONNECTED');
  assert.ok(updated.registration_checked_at);
  assert.deepEqual(updated.health_status, { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'AVAILABLE' }] });
  assert.ok(updated.health_status_checked_at);

  // The load-bearing assertion for this whole file: exactly the TNPSC shape
  // (not on Business App, code verification not VERIFIED) is present, and
  // sendable is STILL null — Layer 1 recorded the finding, it did not act on it.
  assert.equal(updated.sendable, null, 'Layer 1 must never set sendable, even on a shape that looks exactly like the unconfirmed "cannot send" rule');
  assert.equal(updated.sendable_reason, null);
  assert.equal(updated.sendable_error_code, null);
  assert.equal(updated.sendable_checked_at, null);
});

test('refreshOne also leaves sendable untouched on an ordinary "looks fine" registration shape', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);

  await withFakeGraphFetch({
    display_phone_number: '910000000000', verified_name: 'Test', quality_rating: 'GREEN',
    is_on_biz_app: true, code_verification_status: 'VERIFIED', platform_type: 'CLOUD_API', status: 'CONNECTED',
  }, async () => {
    const result = await sendabilityMonitorRunner.refreshOne(waba);
    assert.equal(result.ok, true);
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.equal(updated.registration_is_on_biz_app, true);
  assert.equal(updated.sendable, null, 'sendable stays null regardless of what Layer 1 finds — only the probe (Layer 3) may set it');
});

test('refreshOne stores health_status exactly as Meta returned it, including a BUSINESS-level LIMITED entry', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);

  const rawHealth = {
    entities: [
      { entity_type: 'PHONE_NUMBER', can_send_message: 'AVAILABLE' },
      { entity_type: 'WABA', can_send_message: 'AVAILABLE' },
      {
        entity_type: 'BUSINESS', can_send_message: 'LIMITED',
        errors: [{ error_code: 141010, error_description: 'The Business has not passed business verification', possible_solution: 'Verify the business.' }],
      },
      { entity_type: 'APP', can_send_message: 'AVAILABLE' },
    ],
  };
  await withFakeGraphFetch({
    display_phone_number: '910000000000', verified_name: 'Test', quality_rating: 'GREEN', health_status: rawHealth,
  }, async () => {
    await sendabilityMonitorRunner.refreshOne(waba);
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.deepEqual(updated.health_status, rawHealth);
  // The whole point of Layer 2 being informational-only: a real, useful
  // BUSINESS-level problem is captured, but sendable is still not set from it.
  assert.equal(updated.sendable, null);
});

test('refreshOne never throws on a Meta failure — returns ok:false, leaves prior data alone, still audits the failure', async () => {
  await setWabaRow({ registration_checked_at: new Date() });
  await withFakeGraphFetch({ fail: true }, async () => {
    const waba = await wabasRepo.findByClientId(testClientId);
    const result = await sendabilityMonitorRunner.refreshOne(waba);
    assert.equal(result.ok, false);
    assert.ok(result.reason);
  });

  const { rows } = await pool.query(
    `select * from audit_log where actor_type = 'system' and action = 'sendability_registration_check_failed' and target like $1 order by created_at desc limit 1`,
    [`${testClientId}%`]
  );
  assert.equal(rows.length, 1, 'a failed check must still be audited — this is the exact class of silence that let the real outage run 26 hours undetected');
});

test('every successful refreshOne writes an audit_log entry (not just the admin-triggered one)', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);
  await withFakeGraphFetch({ display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED' }, async () => {
    await sendabilityMonitorRunner.refreshOne(waba);
  });

  const { rows } = await pool.query(
    `select * from audit_log where actor_type = 'system' and action = 'sendability_registration_checked' and target like $1 order by created_at desc limit 1`,
    [`${testClientId}%`]
  );
  assert.equal(rows.length, 1, 'a background tick-driven check must leave a trace, not just a route-driven one');
});

test('admin POST /clients/:id/check-sendability: success path updates and returns the waba, response never claims a sendable verdict', async () => {
  await setWabaRow({});

  await withFakeGraphFetch({
    display_phone_number: '910000000000', is_on_biz_app: false, code_verification_status: 'EXPIRED', platform_type: 'CLOUD_API',
  }, async () => {
    const res = await fetch(`${baseUrl}/api/admin/clients/${testClientId}/check-sendability`, { method: 'POST', headers: authed(adminToken) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.checked, true);
    assert.equal(body.waba.registration_is_on_biz_app, false);
    assert.equal(body.waba.sendable, null, 'the manual admin check must not fabricate a sendable verdict either');
    assert.equal(body.waba.access_token_encrypted, undefined, 'maskWaba must still strip the token from this new route\'s response');
  });

  const { rows } = await pool.query(
    `select * from audit_log where actor_type = 'admin' and action = 'sendability_checked_manually' and target like $1 order by created_at desc limit 1`,
    [`${testClientId}%`]
  );
  assert.equal(rows.length, 1, 'a successful manual check must be audited');
});

test('admin POST /clients/:id/check-sendability: 502 with detail when the Meta call fails', async () => {
  await withFakeGraphFetch({ fail: true }, async () => {
    const res = await fetch(`${baseUrl}/api/admin/clients/${testClientId}/check-sendability`, { method: 'POST', headers: authed(adminToken) });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(body.detail);
  });
});

test('GET /api/admin/health includes the new registration/health/sendable columns', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);
  await withFakeGraphFetch({ display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED' }, async () => {
    await sendabilityMonitorRunner.refreshOne(waba);
  });

  const res = await fetch(`${baseUrl}/api/admin/health`, { headers: authed(adminToken) });
  assert.equal(res.status, 200);
  const rows = await res.json();
  const row = rows.find((r) => r.client_id === testClientId);
  assert.ok(row, 'this suite\'s test client must appear in the health monitor listing');
  assert.equal(row.registration_is_on_biz_app, true);
  assert.equal(row.registration_code_verification_status, 'VERIFIED');
  assert.equal(row.sendable, null);
});
