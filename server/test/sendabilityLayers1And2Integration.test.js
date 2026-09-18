// Sendability monitoring, all three layers plus the combined verdict —
// INTEGRATION coverage. Built after a real 26-hour undetected outage (TNPSC
// Mentors, 2026-09-18), and the first real check cycle's own finding that
// the probe alone is not enough (GV Mart/Brainlit/RD Interlock Bricks
// passed the probe while health_status reported them BLOCKED with 141006).
// See migration 074/075/076_wabas_*.js and sendabilityMonitorRunner.js's
// header comments for the full context.
//
// This file needs the real (shared dev/prod) database — it registers and
// deletes a disposable test client, logs in as the demo admin, and exercises
// the real HTTP routes end to end (admin's check-sendability route, GET
// /api/admin/health, the audit_log rows actually landing). Run it
// deliberately, when you want that coverage — it is not the file that proves
// the load-bearing constraints (the combined verdict logic, the coalesce
// protection, the probe's error.code classification). Those live in
// sendabilityMonitorRunnerUnit.test.js, which needs no database or network
// call at all and runs anywhere, any time. This file's assertions are a
// secondary confirmation that the real HTTP/DB path agrees with the
// unit-level proof, not the primary proof itself.
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

// Registration (Layer 1+2) is a GET to /{phone_number_id}?fields=...; the
// probe (Layer 3) is a POST to /{phone_number_id}/messages — both URLs
// contain TEST_PHONE_NUMBER_ID, so they're told apart by whether the URL
// ends in /messages, not just by substring match.
// `registration`/`probe` each independently: a plain object (success), or
// `{ fail: true }` to simulate that ONE call failing with a Meta-side error
// while the other still runs normally.
async function withFakeGraphFetch({ registration, probe }, fn) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    if (!urlStr.includes('graph.facebook.com') || !urlStr.includes(TEST_PHONE_NUMBER_ID)) {
      return originalFetch(url, options);
    }
    if (urlStr.includes('/messages')) {
      if (!probe) return originalFetch(url, options);
      if (probe.fail) return { ok: false, status: 400, json: async () => ({ error: { message: 'simulated probe network-ish failure' } }) };
      return { ok: false, status: probe.status || 200, json: async () => probe.body };
    }
    if (!registration) return originalFetch(url, options);
    if (registration.fail) return { ok: false, status: 401, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) };
    return { ok: true, json: async () => registration };
  };
  try {
    await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

// Real shapes verified by hand 2026-09-18.
const FORTUNE_PROBE_RESPONSE = { status: 404, body: { error: { message: 'Template name does not exist in the translation', type: 'OAuthException', code: 132001 } } };
const TNPSC_PROBE_RESPONSE = { status: 403, body: { error: { message: 'You do not have the necessary permission to send messages on behalf of this WhatsApp Business Account', type: 'OAuthException', code: 200 } } };
// The exact shape from the first real check cycle: probe permission is
// fine, but the WABA entity itself is BLOCKED for a payment reason.
const GV_MART_HEALTH_STATUS = { entities: [{ entity_type: 'WABA', can_send_message: 'BLOCKED', errors: [{ error_code: 141006, error_description: 'There was an error with your payment method' }] }] };

async function setWabaRow(fields) {
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: TEST_WABA_ID, phone_number_id: TEST_PHONE_NUMBER_ID, status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
    // Explicit resets every call — several tests below assert these
    // stay/become specific values, and upsertForClient only touches columns
    // it's passed.
    registration_is_on_biz_app: null, registration_code_verification_status: null,
    registration_platform_type: null, registration_phone_status: null, registration_checked_at: null,
    health_status: null, health_status_checked_at: null,
    probe_sendable: null, probe_checked_at: null, probe_reason: null, probe_error_code: null, probe_error_data: null,
    sendable: null, sendable_reason: null, sendable_checked_at: null,
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

test('the exact GV Mart shape against the real database: probe passes, health_status is BLOCKED, combined sendable is false while probe_sendable stays true', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);

  await withFakeGraphFetch({
    registration: { display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED', health_status: GV_MART_HEALTH_STATUS },
    probe: FORTUNE_PROBE_RESPONSE,
  }, async () => {
    const result = await sendabilityMonitorRunner.refreshOne(waba);
    assert.equal(result.probe.sendable, true);
    assert.equal(result.verdict.sendable, false);
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.deepEqual(updated.health_status, GV_MART_HEALTH_STATUS);
  assert.equal(updated.probe_sendable, true, 'the raw probe result is preserved distinctly');
  assert.equal(updated.sendable, false, 'the combined verdict is the honest one');
  assert.match(updated.sendable_reason, /141006/);
  assert.match(updated.sendable_reason, /^Health:/);
});

test('the exact TNPSC shape: probe denies permission outright, combined verdict mirrors it regardless of health_status', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);

  await withFakeGraphFetch({
    registration: { display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED', health_status: { entities: [{ entity_type: 'WABA', can_send_message: 'AVAILABLE' }] } },
    probe: TNPSC_PROBE_RESPONSE,
  }, async () => {
    const result = await sendabilityMonitorRunner.refreshOne(waba);
    assert.equal(result.probe.sendable, false);
    assert.equal(result.probe.code, 200);
    assert.equal(result.verdict.sendable, false);
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.equal(updated.probe_sendable, false);
  assert.equal(updated.probe_error_code, 200);
  assert.equal(updated.sendable, false);
  assert.match(updated.sendable_reason, /^Probe:/);
});

test('a healthy account on both signals: sendable true, reason null', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);

  await withFakeGraphFetch({
    registration: { display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED', health_status: { entities: [{ entity_type: 'WABA', can_send_message: 'AVAILABLE' }] } },
    probe: FORTUNE_PROBE_RESPONSE,
  }, async () => {
    await sendabilityMonitorRunner.refreshOne(waba);
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.equal(updated.sendable, true);
  assert.equal(updated.sendable_reason, null);
});

test('a registration response that omits health_status does not wipe a previously-stored BLOCKED reading, against the real database', async () => {
  await setWabaRow({ health_status: JSON.stringify(GV_MART_HEALTH_STATUS), health_status_checked_at: new Date() });
  const waba = await wabasRepo.findByClientId(testClientId);
  assert.deepEqual(waba.health_status, GV_MART_HEALTH_STATUS, 'sanity check on the fixture itself');

  await withFakeGraphFetch({
    registration: { display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED' }, // no health_status this time
    probe: FORTUNE_PROBE_RESPONSE,
  }, async () => {
    const result = await sendabilityMonitorRunner.refreshOne(waba);
    assert.equal(result.verdict.sendable, false, 'the carried-over BLOCKED reading must still be honored');
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.deepEqual(updated.health_status, GV_MART_HEALTH_STATUS, 'must not have been nulled out by this cycle\'s incomplete response');
  assert.equal(updated.sendable, false);
});

test('an unrecognized probe response sets sendable=null and preserves probe_error_data, without guessing', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);

  await withFakeGraphFetch({
    registration: { display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED', health_status: { entities: [] } },
    probe: { status: 400, body: { error: { message: 'Rate limit hit', type: 'OAuthException', code: 80007, error_data: { details: 'too many requests' } } } },
  }, async () => {
    const result = await sendabilityMonitorRunner.refreshOne(waba);
    assert.equal(result.probe.sendable, null);
    assert.equal(result.verdict.sendable, null);
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.equal(updated.probe_sendable, null);
  assert.equal(updated.probe_error_code, 80007);
  assert.deepEqual(updated.probe_error_data, { details: 'too many requests' });
  assert.equal(updated.sendable, null);

  const { rows } = await pool.query(
    `select * from audit_log where actor_type = 'system' and action = 'sendability_unknown' and target like $1 order by created_at desc limit 1`,
    [`${testClientId}%`]
  );
  assert.equal(rows.length, 1, 'an unrecognized probe response must be audited distinctly as sendability_unknown');
});

test('every successful refreshOne writes audit_log entries for all three checks (not just the admin-triggered one)', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);
  await withFakeGraphFetch({
    registration: { display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED', health_status: { entities: [] } },
    probe: FORTUNE_PROBE_RESPONSE,
  }, async () => {
    await sendabilityMonitorRunner.refreshOne(waba);
  });

  for (const action of ['sendability_registration_checked', 'sendability_probed', 'sendable_verdict_computed']) {
    const { rows } = await pool.query(
      `select * from audit_log where actor_type = 'system' and action = $1 and target like $2 order by created_at desc limit 1`,
      [action, `${testClientId}%`]
    );
    assert.equal(rows.length, 1, `${action} must be audited`);
  }
});

test('admin POST /clients/:id/check-sendability: success path returns both the combined verdict and the raw probe result', async () => {
  await setWabaRow({});

  await withFakeGraphFetch({
    registration: { display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED', health_status: GV_MART_HEALTH_STATUS },
    probe: FORTUNE_PROBE_RESPONSE,
  }, async () => {
    const res = await fetch(`${baseUrl}/api/admin/clients/${testClientId}/check-sendability`, { method: 'POST', headers: authed(adminToken) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.checked, true);
    assert.equal(body.waba.probe_sendable, true, 'raw probe result surfaced');
    assert.equal(body.waba.sendable, false, 'combined verdict surfaced, and correctly disagrees with the raw probe result');
    assert.equal(body.waba.access_token_encrypted, undefined, 'maskWaba must still strip the token from this route\'s response');
  });

  const { rows } = await pool.query(
    `select * from audit_log where actor_type = 'admin' and action = 'sendability_checked_manually' and target like $1 order by created_at desc limit 1`,
    [`${testClientId}%`]
  );
  assert.equal(rows.length, 1, 'a successful manual check must be audited');
  assert.match(rows[0].target, /sendable=false/);
});

test('admin POST /clients/:id/check-sendability: 400 when there is no token at all to check', async () => {
  await wabasRepo.upsertForClient(testClientId, { waba_id: TEST_WABA_ID, phone_number_id: null, status: 'connected', access_token_encrypted: null });
  const res = await fetch(`${baseUrl}/api/admin/clients/${testClientId}/check-sendability`, { method: 'POST', headers: authed(adminToken) });
  assert.equal(res.status, 400);
});

test('GET /api/admin/health includes both the combined verdict and the raw probe columns', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);
  await withFakeGraphFetch({
    registration: { display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED', health_status: { entities: [] } },
    probe: FORTUNE_PROBE_RESPONSE,
  }, async () => {
    await sendabilityMonitorRunner.refreshOne(waba);
  });

  const res = await fetch(`${baseUrl}/api/admin/health`, { headers: authed(adminToken) });
  assert.equal(res.status, 200);
  const rows = await res.json();
  const row = rows.find((r) => r.client_id === testClientId);
  assert.ok(row, 'this suite\'s test client must appear in the health monitor listing');
  assert.equal(row.registration_is_on_biz_app, true);
  assert.equal(row.probe_sendable, true);
  assert.equal(row.sendable, true);
});
