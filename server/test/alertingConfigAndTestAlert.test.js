// Alerting config visibility (2026-09-22, read-only investigation ->
// approved build): production has RESEND_API_KEY/ALERT_EMAIL_TO/
// ALERT_WHATSAPP_TO/ALERT_WABA_ID all unset, invisibly — no email or
// WhatsApp alert has ever actually been delivered. Covers:
//   1. alertingConfig.js's getAlertingConfigStatus (pure, reused by index.js's
//      startup warning and the admin Health Monitor banner).
//   2. alertNotifier.notify()'s new { email, whatsapp } structured return —
//      every real send path stubbed (emailService.sendEmail directly;
//      Meta via the standard graph.facebook.com fetch stub), never a real
//      email/WhatsApp send.
//   3. POST /api/admin/alerts/test — confirms it relays notify()'s real
//      result and, critically, writes NO row to alert_events (a test click
//      must never pollute the real alert history).
//   4. GET /api/admin/alerting-status.
//   5. emailService.js's EMAIL_FROM fallback fix (now matches .env.example).
//
// process.env is mutated and restored per-test (these config vars have no
// per-request/per-connection scope to fake instead) — every test resets
// exactly what it changed in its own finally, and BEFORE/after this file's
// own state is captured so nothing leaks into other test files even though
// npm test runs them in separate processes anyway (--test-concurrency=1;
// this is about correctness within THIS file's own multiple tests, not
// cross-file safety).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const alertNotifier = require('../src/services/alertNotifier');
const emailService = require('../src/utils/emailService');
const { getAlertingConfigStatus } = require('../src/utils/alertingConfig');
const { encrypt } = require('../src/utils/encryption');

let server, baseUrl, adminToken, testClientId;

const SUITE_PREFIX = '__test_suite__alertconfig_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Snapshots and restores the 4 config env vars around a test body — used
// by every test that needs a specific configured/unconfigured combination,
// so no test's env mutation can leak into the next one even on failure.
async function withEnv(overrides, fn) {
  const keys = ['RESEND_API_KEY', 'ALERT_EMAIL_TO', 'ALERT_WHATSAPP_TO', 'ALERT_WABA_ID', 'EMAIL_FROM'];
  const original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) {
      if (k in overrides) {
        if (overrides[k] === undefined) delete process.env[k];
        else process.env[k] = overrides[k];
      }
    }
    await fn();
  } finally {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  }
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: 'admin12345' }),
  }).then((r) => r.json());
  adminToken = adminLogin.token;
  assert.ok(adminToken, 'demo admin login must succeed — run `npm run db:seed` first');

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client`,
      email: `test-suite-alertconfig-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  testClientId = registered.client?.id;
  assert.ok(testClientId, 'dedicated test client registration must succeed');

  // A real, connected disposable WABA for the WhatsApp-channel tests —
  // never a real access token (encrypt() over a fake string, same
  // convention every other test file in this suite uses), and every Meta
  // call in this file is stubbed, so nothing ever reaches graph.facebook.com.
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

test('1. getAlertingConfigStatus reflects the 3 real env vars, independent of EMAIL_FROM', async () => {
  await withEnv({ RESEND_API_KEY: undefined, ALERT_EMAIL_TO: undefined, ALERT_WHATSAPP_TO: undefined, ALERT_WABA_ID: undefined }, () => {
    assert.deepEqual(getAlertingConfigStatus(), { resendConfigured: false, emailConfigured: false, whatsappConfigured: false });
  });

  await withEnv({ RESEND_API_KEY: 're_fake', ALERT_EMAIL_TO: 'ops@example.com', ALERT_WHATSAPP_TO: undefined, ALERT_WABA_ID: undefined }, () => {
    const status = getAlertingConfigStatus();
    assert.equal(status.resendConfigured, true);
    assert.equal(status.emailConfigured, true);
    assert.equal(status.whatsappConfigured, false, 'whatsapp needs BOTH ALERT_WHATSAPP_TO and ALERT_WABA_ID');
  });

  // Only one of the two whatsapp vars set — still not configured.
  await withEnv({ ALERT_WHATSAPP_TO: '15551234567', ALERT_WABA_ID: undefined }, () => {
    assert.equal(getAlertingConfigStatus().whatsappConfigured, false);
  });

  await withEnv({ ALERT_WHATSAPP_TO: '15551234567', ALERT_WABA_ID: 'some-waba-id' }, () => {
    assert.equal(getAlertingConfigStatus().whatsappConfigured, true);
  });
});

test('2. alertNotifier.notify(): both channels unconfigured -> both attempted:false with a reason, never throws', async () => {
  await withEnv({ ALERT_EMAIL_TO: undefined, ALERT_WHATSAPP_TO: undefined, ALERT_WABA_ID: undefined }, async () => {
    const result = await alertNotifier.notify({ severity: 'info', alert_type: 'test', message: 'x', details: {} });
    assert.deepEqual(result.email, { attempted: false, sent: false, error: null, reason: 'ALERT_EMAIL_TO is not set' });
    assert.deepEqual(result.whatsapp, { attempted: false, sent: false, error: null, reason: 'ALERT_WHATSAPP_TO/ALERT_WABA_ID are not both set' });
  });
});

test('3. alertNotifier.notify(): email channel success and failure, via a stubbed emailService.sendEmail (never a real Resend call)', async () => {
  const originalSendEmail = emailService.sendEmail;
  try {
    emailService.sendEmail = async () => ({ sent: true });
    await withEnv({ ALERT_EMAIL_TO: 'ops@example.com', ALERT_WHATSAPP_TO: undefined, ALERT_WABA_ID: undefined }, async () => {
      const result = await alertNotifier.notify({ severity: 'critical', alert_type: 'test', message: 'x', details: {} });
      assert.deepEqual(result.email, { attempted: true, sent: true, error: null });
    });

    emailService.sendEmail = async () => { throw new Error('Resend: invalid API key'); };
    await withEnv({ ALERT_EMAIL_TO: 'ops@example.com', ALERT_WHATSAPP_TO: undefined, ALERT_WABA_ID: undefined }, async () => {
      const result = await alertNotifier.notify({ severity: 'critical', alert_type: 'test', message: 'x', details: {} });
      assert.equal(result.email.attempted, true);
      assert.equal(result.email.sent, false);
      assert.equal(result.email.error, 'Resend: invalid API key', 'must surface the exact error text, not a paraphrase');
    });
  } finally {
    emailService.sendEmail = originalSendEmail;
  }
});

test('4. alertNotifier.notify(): whatsapp channel success and a real Meta rejection, via the standard graph.facebook.com fetch stub', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.test' }] }) };
    };
    await withEnv({ ALERT_EMAIL_TO: undefined, ALERT_WHATSAPP_TO: '15551234567', ALERT_WABA_ID: `${SUITE_PREFIX}waba` }, async () => {
      const result = await alertNotifier.notify({ severity: 'warning', alert_type: 'test', message: 'x', details: {} });
      assert.deepEqual(result.whatsapp, { attempted: true, sent: true, error: null });
    });

    global.fetch = async (url, options) => {
      if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
      return {
        ok: false, status: 400,
        json: async () => ({ error: { message: 'wasi_ops_alert does not exist', code: 132001 } }),
      };
    };
    await withEnv({ ALERT_EMAIL_TO: undefined, ALERT_WHATSAPP_TO: '15551234567', ALERT_WABA_ID: `${SUITE_PREFIX}waba` }, async () => {
      const result = await alertNotifier.notify({ severity: 'warning', alert_type: 'test', message: 'x', details: {} });
      assert.equal(result.whatsapp.attempted, true);
      assert.equal(result.whatsapp.sent, false);
      assert.equal(result.whatsapp.error, 'wasi_ops_alert does not exist');
      assert.equal(result.whatsapp.metaError.code, 132001, 'Meta\'s real error body must be carried through, not summarized away');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('5. POST /api/admin/alerts/test: admin-only, relays the real notify() result, and writes NO row to alert_events', async () => {
  const unauth = await fetch(`${baseUrl}/api/admin/alerts/test`, { method: 'POST' });
  assert.equal(unauth.status, 401);

  const { rows: before } = await pool.query(`select count(*)::int as c from alert_events where alert_type = 'test_alert'`);

  const originalNotify = alertNotifier.notify;
  let capturedAlertEvent = null;
  try {
    alertNotifier.notify = async (alertEvent) => {
      capturedAlertEvent = alertEvent;
      return { email: { attempted: false, sent: false, error: null, reason: 'stub' }, whatsapp: { attempted: false, sent: false, error: null, reason: 'stub' } };
    };
    const res = await fetch(`${baseUrl}/api/admin/alerts/test`, { method: 'POST', headers: authed(adminToken) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.email, { attempted: false, sent: false, error: null, reason: 'stub' });
    assert.deepEqual(data.whatsapp, { attempted: false, sent: false, error: null, reason: 'stub' });
  } finally {
    alertNotifier.notify = originalNotify;
  }

  assert.equal(capturedAlertEvent.alert_type, 'test_alert');
  assert.equal(capturedAlertEvent.severity, 'info');
  assert.match(capturedAlertEvent.message, /test alert/i);

  const { rows: after } = await pool.query(`select count(*)::int as c from alert_events where alert_type = 'test_alert'`);
  assert.equal(after[0].c, before[0].c, 'a test-alert click must never write a real alert_events row');
});

test('6. GET /api/admin/alerting-status: admin-only, reflects real env state', async () => {
  const unauth = await fetch(`${baseUrl}/api/admin/alerting-status`);
  assert.equal(unauth.status, 401);

  await withEnv({ RESEND_API_KEY: undefined, ALERT_EMAIL_TO: undefined, ALERT_WHATSAPP_TO: undefined, ALERT_WABA_ID: undefined }, async () => {
    const res = await fetch(`${baseUrl}/api/admin/alerting-status`, { headers: authed(adminToken) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, { resendConfigured: false, emailConfigured: false, whatsappConfigured: false });
  });
});

test('7. emailService.js: EMAIL_FROM falls back to noreply@yourdomain.com (matches .env.example), not the old noreply@example.com', async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;
  try {
    global.fetch = async (url, options) => {
      if (!String(url).includes('api.resend.com')) return originalFetch(url, options);
      capturedBody = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ id: 'fake' }) };
    };
    await withEnv({ RESEND_API_KEY: 're_fake_key', EMAIL_FROM: undefined }, async () => {
      await emailService.sendEmail({ to: 'someone@example.com', subject: 'x', html: '<p>x</p>' });
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.ok(capturedBody, 'the stubbed Resend call must actually have been reached');
  assert.match(capturedBody.from, /noreply@yourdomain\.com/);
  assert.doesNotMatch(capturedBody.from, /noreply@example\.com/);
});
