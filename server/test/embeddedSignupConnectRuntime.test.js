// Runtime verification of embeddedSignup.js's connect() promise, requested
// directly as part of a full evidence-gathering pass on the Embedded Signup
// path (2026-09-07, after 12+ real onboarding failures and a Meta support
// escalation). Drives the REAL connect() function in a real browser
// (Playwright), mocking only window.FB.login's callback and synthesizing
// the postMessage events Meta's popup would send - everything else
// (loadSdk's script-tag/window.fbAsyncInit dance, the message listener's
// origin filter, sessionData merging, pendingCodeReject, the hard timeout)
// runs unmodified, exactly as shipped.
//
// window.FB.login is mocked because there is no way to drive Meta's real
// popup from an automated test. The postMessage events are dispatched as
// genuine MessageEvents via window.dispatchEvent with a spoofed `origin` -
// this is necessary (a real cross-window postMessage's origin can't be
// spoofed from the same page) and correct: it exercises the actual
// window.addEventListener('message', ...) listener this file registers,
// identically to a real facebook.com-origin message arriving.
//
// Five scenarios, each carried through to the real backend
// (POST /whatsapp/connect or /whatsapp/connect-incomplete, metaClient
// stubbed exactly like onboardingServerSideDiscovery.test.js) so the
// resulting wabas row and audit_log entry are asserted for real, not just
// the client-side promise outcome.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const metaClient = require('../src/utils/metaClient');

process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:4001';

let server, baseUrl, browser, page, clientToken, testClientId;

const original = {};
function stubMetaClient(overrides) {
  for (const key of Object.keys(overrides)) {
    if (!(key in original)) original[key] = metaClient[key];
    metaClient[key] = overrides[key];
  }
}
function restoreMetaClient() {
  Object.assign(metaClient, original);
}

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

before(async () => {
  const app = createApp();
  server = app.listen(4001);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = 'http://localhost:4001';

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: '__test_suite__esrt_client',
      email: `test-suite-esrt-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(async () => {
  restoreMetaClient();
  stubMetaClient({
    exchangeCodeForToken: async () => 'short-lived-fake',
    exchangeForLongLivedToken: async () => 'long-lived-fake',
    subscribeAppToWaba: async () => ({}),
    registerPhoneNumber: async () => ({}),
    getPhoneNumberDetails: async () => ({ verified_name: 'Test Business', display_phone_number: '+1 555 0100', quality_rating: 'GREEN' }),
  });

  page = await browser.newPage();
  page.on('pageerror', (err) => console.error('[connect() runtime test pageerror]', err.message));
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: path.join(__dirname, '..', '..', 'embeddedSignup.js') });
});

// Runs connect() in the page with a scripted window.FB.login and a
// scripted sequence of postMessage events, returning either
// { resolved: true, value } or { resolved: false, message, incomplete, waba_id }.
// loginBehavior: 'code' | 'codeless' | 'none' (FB.login's callback never fires)
// messages: array of { atMs, event, data } dispatched as WA_EMBEDDED_SIGNUP
// postMessages from a facebook.com-spoofed origin.
async function runConnect(page, { loginBehavior, code, messages = [], fastForwardHardTimeout = false }) {
  return page.evaluate(async ({ loginBehavior, code, messages, fastForwardHardTimeout }) => {
    // loadSdk() would otherwise try to load the real facebook.com SDK
    // script and wait for it to call window.fbAsyncInit - replaced here
    // with a synchronous fake so connect()'s OWN logic (everything after
    // loadSdk resolves) runs completely unmodified.
    const fakeScript = document.createElement('script');
    fakeScript.dataset.wasiFbSdk = 'true';
    document.head.appendChild(fakeScript);

    window.FB = {
      init: () => {},
      login: (cb, opts) => {
        window.__lastFbLoginOpts = opts;
        if (loginBehavior === 'none') return; // callback never fires
        setTimeout(() => {
          if (loginBehavior === 'code') {
            cb({ authResponse: { code }, status: 'connected' });
          } else {
            cb({ authResponse: null, status: 'not_authorized' });
          }
        }, 10);
      },
    };

    for (const m of messages) {
      setTimeout(() => {
        window.dispatchEvent(new MessageEvent('message', {
          origin: 'https://www.facebook.com',
          data: JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: m.event, data: m.data || {} }),
        }));
      }, m.atMs);
    }

    const connectPromise = window.WasiEmbeddedSignup.connect({
      appId: 'test-app-id',
      configId: 'test-config-id',
    });

    // fbAsyncInit is set synchronously by loadSdk() before FB.login is ever
    // reached - calling it now (next microtask) lets the mocked SDK
    // "finish loading" so connect() proceeds into its real logic.
    await new Promise((r) => setTimeout(r, 0));
    if (window.fbAsyncInit) window.fbAsyncInit();

    if (fastForwardHardTimeout) {
      // Real page timers under Playwright's clock mock - see clock.install()
      // call in the test itself, which must happen before this evaluate
      // runs so LOGIN_TIMEOUT_MS's real setTimeout is captured by the mock.
    }

    try {
      const value = await connectPromise;
      return { resolved: true, value };
    } catch (err) {
      return { resolved: false, message: err.message, incomplete: !!err.incomplete, waba_id: err.waba_id };
    }
  }, { loginBehavior, code, messages, fastForwardHardTimeout });
}

test('runtime 1: code returned, FINISH carries both waba_id and phone_number_id - resolves with full data', async () => {
  const result = await runConnect(page, {
    loginBehavior: 'code',
    code: 'real-code-1',
    messages: [{ atMs: 30, event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: 'waba-rt1', phone_number_id: 'phone-rt1' } }],
  });
  assert.equal(result.resolved, true, `connect() should resolve: ${JSON.stringify(result)}`);
  assert.equal(result.value.code, 'real-code-1');
  assert.equal(result.value.waba_id, 'waba-rt1');
  assert.equal(result.value.phone_number_id, 'phone-rt1');
  assert.equal(result.value.via_coexistence, true);

  const res = await fetch(`${baseUrl}/api/onboarding/whatsapp/connect`, {
    method: 'POST', headers: authed(clientToken), body: JSON.stringify(result.value),
  });
  assert.equal(res.status, 200);
  const { rows } = await pool.query('select waba_id, phone_number_id, status from wabas where client_id = $1', [testClientId]);
  assert.equal(rows[0].waba_id, 'waba-rt1');
  assert.equal(rows[0].phone_number_id, 'phone-rt1');
  assert.equal(rows[0].status, 'connected');
  const { rows: audit } = await pool.query(`select action from audit_log where actor_id = $1 and action = 'whatsapp_connected' order by created_at desc limit 1`, [testClientId]);
  assert.equal(audit.length, 1, 'a whatsapp_connected audit entry must exist');
});

test('runtime 2: code returned, FINISH carries waba_id only - resolves, backend discovers phone_number_id', async () => {
  stubMetaClient({ listPhoneNumbers: async () => [{ id: 'phone-rt2-discovered', display_phone_number: '+1 555 0102' }] });

  const result = await runConnect(page, {
    loginBehavior: 'code',
    code: 'real-code-2',
    messages: [{ atMs: 30, event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: 'waba-rt2' } }],
  });
  assert.equal(result.resolved, true, `connect() should resolve: ${JSON.stringify(result)}`);
  assert.equal(result.value.waba_id, 'waba-rt2');
  assert.equal(result.value.phone_number_id, undefined, 'phone_number_id must NOT arrive client-side under v4 - this is the whole point of server-side discovery');

  const res = await fetch(`${baseUrl}/api/onboarding/whatsapp/connect`, {
    method: 'POST', headers: authed(clientToken), body: JSON.stringify(result.value),
  });
  assert.equal(res.status, 200);
  const { rows } = await pool.query('select waba_id, phone_number_id, status from wabas where client_id = $1', [testClientId]);
  assert.equal(rows[0].waba_id, 'waba-rt2');
  assert.equal(rows[0].phone_number_id, 'phone-rt2-discovered', 'server-side discovery (item 25 Part A) must fill this in');
  assert.equal(rows[0].status, 'connected');
});

test('runtime 3: code returned, FINISH carries nothing - resolves client-side, fails cleanly server-side when discovery also can\'t resolve it', async () => {
  stubMetaClient({ debugToken: async () => ({ granular_scopes: [] }) }); // no WABA scope at all

  const result = await runConnect(page, {
    loginBehavior: 'code',
    code: 'real-code-3',
    messages: [{ atMs: 30, event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: {} }],
  });
  assert.equal(result.resolved, true, `connect() should resolve even with empty FINISH data - see resolve-on-FINISH comment: ${JSON.stringify(result)}`);
  assert.equal(result.value.waba_id, undefined);
  assert.equal(result.value.phone_number_id, undefined);

  const res = await fetch(`${baseUrl}/api/onboarding/whatsapp/connect`, {
    method: 'POST', headers: authed(clientToken), body: JSON.stringify(result.value),
  });
  assert.equal(res.status, 502, 'no silent failure - a real 502 with a specific reason');
  const body = await res.json();
  assert.match(body.detail, /never sent a WhatsApp Business Account/);
  const { rows } = await pool.query('select status from wabas where client_id = $1', [testClientId]);
  assert.equal(rows[0].status, 'failed');
  const { rows: audit } = await pool.query(`select action from audit_log where actor_id = $1 and action = 'whatsapp_connect_failed' order by created_at desc limit 1`, [testClientId]);
  assert.equal(audit.length, 1, 'a whatsapp_connect_failed audit entry must exist - no silent failure path');
});

test('runtime 4: codeless callback (not_authorized), FINISH arrives later - rejects with err.incomplete, never a generic failure', async () => {
  const result = await runConnect(page, {
    loginBehavior: 'codeless',
    messages: [{ atMs: 60, event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: 'waba-rt4' } }],
  });
  assert.equal(result.resolved, false, 'must reject, not resolve with an undefined code');
  assert.equal(result.incomplete, true, `must be marked incomplete, not a generic rejection: ${JSON.stringify(result)}`);
  assert.equal(result.waba_id, 'waba-rt4');

  const res = await fetch(`${baseUrl}/api/onboarding/whatsapp/connect-incomplete`, {
    method: 'POST', headers: authed(clientToken), body: JSON.stringify({ waba_id: result.waba_id }),
  });
  assert.equal(res.status, 200);
  const { rows } = await pool.query('select waba_id, status from wabas where client_id = $1', [testClientId]);
  assert.equal(rows[0].waba_id, 'waba-rt4');
  assert.equal(rows[0].status, 'incomplete_meta_linked');
  const { rows: audit } = await pool.query(`select action from audit_log where actor_id = $1 and action = 'whatsapp_connect_incomplete' order by created_at desc limit 1`, [testClientId]);
  assert.equal(audit.length, 1, 'a whatsapp_connect_incomplete audit entry must exist');
});

test('runtime 5: codeless callback (not_authorized), nothing ever arrives - waits out the full hard timeout, rejects generically, never silently hangs', async () => {
  // Playwright's Clock lets the page's own LOGIN_TIMEOUT_MS (10 real
  // minutes) fire without the test actually waiting 10 minutes - installed
  // fresh per-test since beforeEach creates a new page.
  await page.clock.install();
  const resultPromise = runConnect(page, { loginBehavior: 'codeless', messages: [] });
  // Let the codeless FB.login callback (scheduled via a real setTimeout(10))
  // actually fire before advancing the clock past it.
  await page.clock.fastForward(50);
  await page.clock.fastForward('10:01:00');
  const result = await resultPromise;

  assert.equal(result.resolved, false);
  assert.equal(result.incomplete, false, 'no FINISH was ever seen - must be the generic timeout rejection, not marked incomplete');
  assert.match(result.message, /Still not connected after 10 minutes/);
});
