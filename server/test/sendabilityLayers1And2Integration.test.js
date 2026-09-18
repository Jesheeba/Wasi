// Sendability monitoring, all three layers — INTEGRATION coverage. Built
// after a real 26-hour undetected outage (TNPSC Mentors, 2026-09-18). See
// migration 074_wabas_sendability.js/075_wabas_sendable_error_data.js and
// sendabilityMonitorRunner.js's header comments for the full context.
//
// This file needs the real (shared dev/prod) database — it registers and
// deletes a disposable test client, logs in as the demo admin, and exercises
// the real HTTP routes end to end (admin's check-sendability route, GET
// /api/admin/health, the audit_log rows actually landing). Run it
// deliberately, when you want that coverage — it is not the file that proves
// the load-bearing constraints (Layer 1 cannot set sendable; the probe
// classifies on error.code, not HTTP status; an unrecognized response is
// never guessed). Those live in sendabilityMonitorRunnerUnit.test.js, which
// needs no database or network call at all and runs anywhere, any time.
// This file's assertions are a secondary confirmation that the real
// HTTP/DB path agrees with the unit-level proof, not the primary proof
// itself.
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
// ends in /messages, not just by substring match (an earlier version of
// this file's helper didn't make this distinction and would have fed the
// probe's POST the registration fixture's shape by accident).
// `registration`/`probe` each independently: a plain object (success), or
// `{ fail: true }` to simulate that ONE call failing with a Meta-side error
// while the other still runs normally — same "options must be forwarded to
// the real fetch" precedent as messagingTier.test.js's own helper.
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

// Real shapes verified by hand 2026-09-18 — reused across tests so the
// integration coverage matches exactly what was actually observed, not an
// invented approximation.
const FORTUNE_PROBE_RESPONSE = { status: 404, body: { error: { message: 'Template name does not exist in the translation', type: 'OAuthException', code: 132001 } } };
const TNPSC_PROBE_RESPONSE = { status: 403, body: { error: { message: 'You do not have the necessary permission to send messages on behalf of this WhatsApp Business Account', type: 'OAuthException', code: 200 } } };

async function setWabaRow(fields) {
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: TEST_WABA_ID, phone_number_id: TEST_PHONE_NUMBER_ID, status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
    // Explicit resets every call — several tests below assert these stay
    // null/set, and upsertForClient only touches columns it's passed.
    registration_is_on_biz_app: null, registration_code_verification_status: null,
    registration_platform_type: null, registration_phone_status: null, registration_checked_at: null,
    health_status: null, health_status_checked_at: null,
    sendable: null, sendable_checked_at: null, sendable_reason: null, sendable_error_code: null, sendable_error_data: null,
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

test('refreshOne persists registration fields and health_status even when they look exactly like the unconfirmed "cannot send" rule, but sendable comes from the probe, not from them', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);

  await withFakeGraphFetch({
    registration: {
      display_phone_number: '910000000000', verified_name: 'Test', quality_rating: 'GREEN',
      is_on_biz_app: false, code_verification_status: 'EXPIRED', platform_type: 'CLOUD_API', status: 'CONNECTED',
      health_status: { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'AVAILABLE' }] },
    },
    probe: FORTUNE_PROBE_RESPONSE, // deliberately the HEALTHY probe result, contradicting the registration heuristic
  }, async () => {
    const result = await sendabilityMonitorRunner.refreshOne(waba);
    assert.equal(result.ok, true);
    assert.equal(result.registration.isOnBizApp, false);
    assert.equal(result.registration.codeVerificationStatus, 'EXPIRED');
    assert.equal(result.probe.sendable, true, 'the probe, not the registration heuristic, decides sendable');
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.equal(updated.registration_is_on_biz_app, false);
  assert.equal(updated.registration_code_verification_status, 'EXPIRED');
  assert.equal(updated.registration_platform_type, 'CLOUD_API');
  assert.equal(updated.registration_phone_status, 'CONNECTED');
  assert.ok(updated.registration_checked_at);
  assert.deepEqual(updated.health_status, { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'AVAILABLE' }] });
  assert.ok(updated.health_status_checked_at);

  // The load-bearing assertion for this file: registration looks exactly
  // like the "cannot send" shape, but sendable=true because that's what the
  // PROBE found — proof the write path really is independent, against the
  // real database, not just in the stubbed unit test.
  assert.equal(updated.sendable, true);
  assert.equal(updated.sendable_error_code, null);
});

test('the exact TNPSC shape: registration/health look completely normal, but the probe still reports sendable=false', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);

  await withFakeGraphFetch({
    registration: {
      display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED',
      health_status: { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'AVAILABLE' }, { entity_type: 'BUSINESS', can_send_message: 'AVAILABLE' }] },
    },
    probe: TNPSC_PROBE_RESPONSE,
  }, async () => {
    const result = await sendabilityMonitorRunner.refreshOne(waba);
    assert.equal(result.probe.sendable, false);
    assert.equal(result.probe.code, 200);
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.equal(updated.registration_is_on_biz_app, true, 'registration looks fine — this is exactly why health_status/registration alone would have missed this');
  assert.equal(updated.sendable, false);
  assert.equal(updated.sendable_error_code, 200);
  assert.match(updated.sendable_reason, /necessary permission/);
});

test('refreshOne stores health_status exactly as Meta returned it, including a BUSINESS-level LIMITED entry, independent of the probe result', async () => {
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
    registration: { display_phone_number: '910000000000', health_status: rawHealth },
    probe: FORTUNE_PROBE_RESPONSE,
  }, async () => {
    await sendabilityMonitorRunner.refreshOne(waba);
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.deepEqual(updated.health_status, rawHealth);
  assert.equal(updated.sendable, true, 'Layer 2 is informational only — a real BUSINESS-level problem is captured, but the probe still decides sendable');
});

test('an unrecognized probe response sets sendable=null and preserves error_data, without guessing', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);

  await withFakeGraphFetch({
    registration: { display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED' },
    probe: { status: 400, body: { error: { message: 'Rate limit hit', type: 'OAuthException', code: 80007, error_data: { details: 'too many requests' } } } },
  }, async () => {
    const result = await sendabilityMonitorRunner.refreshOne(waba);
    assert.equal(result.probe.sendable, null);
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.equal(updated.sendable, null);
  assert.equal(updated.sendable_error_code, 80007);
  assert.deepEqual(updated.sendable_error_data, { details: 'too many requests' });

  const { rows } = await pool.query(
    `select * from audit_log where actor_type = 'system' and action = 'sendability_unknown' and target like $1 order by created_at desc limit 1`,
    [`${testClientId}%`]
  );
  assert.equal(rows.length, 1, 'an unrecognized probe response must be audited distinctly as sendability_unknown');
});

test('registration check failing does not prevent the probe from running or writing sendable', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);

  await withFakeGraphFetch({ registration: { fail: true }, probe: TNPSC_PROBE_RESPONSE }, async () => {
    const result = await sendabilityMonitorRunner.refreshOne(waba);
    assert.equal(result.registration.ok, false);
    assert.equal(result.probe.ok, true);
    assert.equal(result.probe.sendable, false);
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.equal(updated.sendable, false, 'an unrelated registration-check failure must never suppress the probe or its write');
});

test('every successful refreshOne writes audit_log entries for both layers (not just the admin-triggered one)', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);
  await withFakeGraphFetch({
    registration: { display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED' },
    probe: FORTUNE_PROBE_RESPONSE,
  }, async () => {
    await sendabilityMonitorRunner.refreshOne(waba);
  });

  const { rows: registrationRows } = await pool.query(
    `select * from audit_log where actor_type = 'system' and action = 'sendability_registration_checked' and target like $1 order by created_at desc limit 1`,
    [`${testClientId}%`]
  );
  assert.equal(registrationRows.length, 1, 'a background tick-driven check must leave a trace, not just a route-driven one');

  const { rows: probeRows } = await pool.query(
    `select * from audit_log where actor_type = 'system' and action = 'sendability_probed' and target like $1 order by created_at desc limit 1`,
    [`${testClientId}%`]
  );
  assert.equal(probeRows.length, 1, 'a classified probe result must also leave its own trace');
});

test('admin POST /clients/:id/check-sendability: success path updates and returns the waba with a real sendable verdict', async () => {
  await setWabaRow({});

  await withFakeGraphFetch({
    registration: { display_phone_number: '910000000000', is_on_biz_app: false, code_verification_status: 'EXPIRED', platform_type: 'CLOUD_API' },
    probe: TNPSC_PROBE_RESPONSE,
  }, async () => {
    const res = await fetch(`${baseUrl}/api/admin/clients/${testClientId}/check-sendability`, { method: 'POST', headers: authed(adminToken) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.checked, true);
    assert.equal(body.waba.registration_is_on_biz_app, false);
    assert.equal(body.waba.sendable, false);
    assert.equal(body.waba.sendable_error_code, 200);
    assert.equal(body.waba.access_token_encrypted, undefined, 'maskWaba must still strip the token from this route\'s response');
  });

  const { rows } = await pool.query(
    `select * from audit_log where actor_type = 'admin' and action = 'sendability_checked_manually' and target like $1 order by created_at desc limit 1`,
    [`${testClientId}%`]
  );
  assert.equal(rows.length, 1, 'a successful manual check must be audited');
  assert.match(rows[0].target, /sendable=false/);
});

test('admin POST /clients/:id/check-sendability: 502 with detail when the token itself cannot be used at all', async () => {
  // A waba row whose token is missing entirely — refreshOne's own pre-flight
  // guard, still the one case this route treats as a real failure to report.
  await wabasRepo.upsertForClient(testClientId, { waba_id: TEST_WABA_ID, phone_number_id: null, status: 'connected', access_token_encrypted: null });
  const res = await fetch(`${baseUrl}/api/admin/clients/${testClientId}/check-sendability`, { method: 'POST', headers: authed(adminToken) });
  assert.equal(res.status, 400, 'no phone_number_id at all is caught before refreshOne even runs, by the route\'s own existing guard');
});

test('GET /api/admin/health includes the new registration/health/sendable columns', async () => {
  await setWabaRow({});
  const waba = await wabasRepo.findByClientId(testClientId);
  await withFakeGraphFetch({
    registration: { display_phone_number: '910000000000', is_on_biz_app: true, code_verification_status: 'VERIFIED' },
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
  assert.equal(row.registration_code_verification_status, 'VERIFIED');
  assert.equal(row.sendable, true);
});
