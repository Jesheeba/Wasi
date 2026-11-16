// Bug: localStorage['client_token'] is shared across every tab on this
// origin. If tab A is left open on account A (a very normal thing to do -
// staff leave the CRM open for days while polling for new messages) and, in
// a SECOND tab that inherits the same shared storage, someone logs out and
// into a DIFFERENT account B, that overwrites client_token out from under
// tab A. Tab A never reloads, so its UI chrome keeps showing account A's
// name while its next poll (every 4s) now authenticates as B and renders
// B's chats - a cross-tenant data leak. Fixed by comparing the decoded
// token's tenant id against the tab's own session on the 'storage' event
// (which only fires in tabs that did NOT make the write) and forcing that
// tab back to the login screen when they differ.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
// app.js hardcodes its API_BASE to http://localhost:4000 for any non-4000
// dev port (see its own top-of-file comment) - this suite serves the app
// itself from 4005 (4000 is often already held by a real locally-running
// dev server, which must never be touched) and redirects that hardcoded
// :4000 API traffic to 4005 via Playwright route interception instead.
process.env.ALLOWED_ORIGINS = 'http://localhost:4005';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server, baseUrl, browser;

const SUITE_PREFIX = '__test_suite__crosstab_';
const PASSWORD = 'test-suite-password-12345';
const CLIENT_A = { email: `test-suite-crosstab-a-${Date.now()}@wasi.local`, name: `${SUITE_PREFIX}a` };
const CLIENT_B = { email: `test-suite-crosstab-b-${Date.now()}@wasi.local`, name: `${SUITE_PREFIX}b` };

before(async () => {
  const app = createApp();
  server = app.listen(4005);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = 'http://localhost:4005';

  for (const client of [CLIENT_A, CLIENT_B]) {
    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessName: client.name, email: client.email, password: PASSWORD }),
    }).then((r) => r.json());
  }

  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function redirectHardcodedApiPort(page) {
  await page.route('http://localhost:4000/**', (route) => {
    const url = new URL(route.request().url());
    route.continue({ url: `${baseUrl}${url.pathname}${url.search}` });
  });
}

// First login of the suite, in a fresh page with no stored session yet.
async function freshLogin(page, client) {
  await redirectHardcodedApiPort(page);
  await page.goto(`${baseUrl}/app`);
  await fillAndSubmitLogin(page, client);
}

async function fillAndSubmitLogin(page, client) {
  await page.waitForSelector('#login-email', { state: 'visible', timeout: 5000 });
  await page.fill('#login-email', client.email);
  await page.fill('#login-password', PASSWORD);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('#app-shell', { state: 'visible', timeout: 5000 });
}

// Real account-switch flow: click logout, then log in as a different
// account - this is how a shared-storage tab actually ends up authenticated
// as someone else without a full browser restart.
async function logoutThenLogin(page, client) {
  await page.click('#user-profile-item');
  await page.waitForSelector('#modal-confirm.open', { timeout: 3000 });
  await page.click('#modal-confirm-action-btn');
  await fillAndSubmitLogin(page, client);
}

test('leaving tab A open on account A, then switching accounts to B in tab B (shared storage), signs tab A back out', async () => {
  const context = await browser.newContext();
  const tabA = await context.newPage();
  await freshLogin(tabA, CLIENT_A);

  // tabB is a second tab on the same shared storage - it silently resumes
  // tabA's own account A session first, exactly as it would in real use.
  const tabB = await context.newPage();
  await redirectHardcodedApiPort(tabB);
  await tabB.goto(`${baseUrl}/app`);
  await tabB.waitForSelector('#app-shell', { state: 'visible', timeout: 5000 });

  // From tabB, the staff member switches the browser to a different client
  // account (B) - this is the write that overwrites client_token under tabA.
  await logoutThenLogin(tabB, CLIENT_B);

  // tabA never navigated or reloaded - it only finds out via the 'storage'
  // event fired by tabB's new login.
  await tabA.waitForSelector('#auth-view', { state: 'visible', timeout: 5000 });
  assert.equal(await tabA.locator('#app-shell').isVisible(), false,
    'tabA must be kicked back to the login screen once a different account logs in on tabB');

  // tabB (the tab that actually performed the new login) must be unaffected.
  assert.equal(await tabB.locator('#app-shell').isVisible(), true,
    'tabB, which performed the new login, must stay logged in and unaffected');

  await context.close();
});

test('re-authenticating as the SAME account elsewhere (fresh token, same tenant) does not kick the first tab out', async () => {
  const context = await browser.newContext();
  const tabA = await context.newPage();
  await freshLogin(tabA, CLIENT_A);

  const tabB = await context.newPage();
  await redirectHardcodedApiPort(tabB);
  await tabB.goto(`${baseUrl}/app`);
  await tabB.waitForSelector('#app-shell', { state: 'visible', timeout: 5000 });

  // Simulates a fresh re-login as the SAME account (e.g. a token refresh, or
  // another device) landing a new token string into shared storage, without
  // going through tabB's own logout flow (which would itself notify tabA -
  // already covered by the different-account case above).
  const newToken = await tabB.evaluate(async ({ apiBase, email, password }) => {
    const res = await fetch(`${apiBase}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return (await res.json()).token;
  }, { apiBase: 'http://localhost:4000', email: CLIENT_A.email, password: PASSWORD });
  await tabB.evaluate((token) => localStorage.setItem('client_token', token), newToken);
  await tabA.waitForTimeout(500);

  assert.equal(await tabA.locator('#app-shell').isVisible(), true,
    'tabA must stay logged in when the SAME account simply re-authenticates elsewhere with a fresh token');

  await context.close();
});
