// Real-browser coverage for PLAN.md item 12's frontend — the New Campaign
// modal's Smart Sending dropdown. Backend correctness (the real
// hasRecentSend check, the skip behavior) is broadcastSmartSending.test.js's
// job; this covers what only a real browser can show — picking an option
// and launching actually persists smartSendingHours server-side.
//
// Same fixed-port-4000 + ALLOWED_ORIGINS override as templateLibraryUI.test.js
// (the original precedent) — safe alongside any other file now that npm
// test forces --test-concurrency=1 (CLAUDE.md's Conventions section).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.ALLOWED_ORIGINS = 'http://localhost:4000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server, browser, page, baseUrl, testClientId, clientToken;

const SUITE_PREFIX = '__test_suite__smartsendingui_';
const EMAIL = `test-suite-smartsendingui-${Date.now()}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

before(async () => {
  const app = createApp();
  server = app.listen(4000);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = 'http://localhost:4000';

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${SUITE_PREFIX}client`, email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json());
  testClientId = registered.client?.id;
  clientToken = registered.token;
  assert.ok(testClientId && clientToken, 'dedicated test client registration must succeed');

  // Real Utility-category template (stubbed Meta), matching the same
  // consent-sidestepping reasoning as every other broadcast test.
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (!String(url).includes('graph.facebook.com')) return realFetch(url, opts);
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_tpl`, status: 'APPROVED', category: 'UTILITY' }) };
  };
  const templateRes = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      name: `${SUITE_PREFIX}tpl`, category: 'Utility',
      body: 'A real smart sending UI test message with no variables.',
    }),
  });
  assert.equal(templateRes.status, 201, JSON.stringify(await templateRes.clone().json()));
  global.fetch = realFetch;

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(`${baseUrl}/index.html`);
  await page.fill('#login-email', EMAIL);
  await page.fill('#login-password', PASSWORD);
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(1500);
  const loggedIn = await page.evaluate(() => getComputedStyle(document.getElementById('app-shell')).display !== 'none');
  assert.ok(loggedIn, 'login must complete before any test runs');
});

after(async () => {
  await browser?.close();
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('1. picking a Smart Sending option and launching persists smart_sending_hours server-side', async () => {
  await page.click('.nav-item[data-view="campaigns"]');
  await page.waitForTimeout(300);
  await page.click('#open-create-broadcast-modal');
  await page.waitForTimeout(300);

  await page.fill('#new-campaign-name', `${SUITE_PREFIX}Campaign`);
  // CLAUDE.md's documented convention: set the <select> value directly and
  // dispatch a real change event rather than driving selectOption()'s own
  // actionability polling, which has proven unreliable against this app.
  await page.evaluate(() => {
    const templateSelect = document.getElementById('new-campaign-template');
    const opt = [...templateSelect.options].find((o) => o.value.includes('smartsendingui'));
    templateSelect.value = opt.value;
    templateSelect.dispatchEvent(new Event('change', { bubbles: true }));

    const smartSelect = document.getElementById('new-campaign-smart-sending');
    smartSelect.value = '24';
    smartSelect.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);

  await page.click('#create-campaign-form button[type="submit"]');
  await page.waitForTimeout(800);

  const broadcasts = await fetch(`${baseUrl}/api/broadcasts`, { headers: authed(clientToken) }).then((r) => r.json());
  const created = broadcasts.find((b) => b.title === `${SUITE_PREFIX}Campaign`);
  assert.ok(created, 'the campaign must actually be created');

  const row = await pool.query('select smart_sending_hours from broadcasts where id = $1', [created.id]);
  assert.equal(row.rows[0].smart_sending_hours, 24, 'the picked Smart Sending window must persist server-side, not just show in the form');
});
