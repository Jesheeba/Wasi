// Real-browser coverage for PLAN.md item 11's frontend — the Campaigns
// table's Pause/Resume button (index.html's #broadcasts-table-body,
// app.js's renderBroadcasts). Backend correctness (the real listActive()
// gate, the actual send pipeline) is broadcastPauseResume.test.js's job;
// this covers what only a real browser can show — the button appears for
// the right status, click it, and the row updates to reflect what the
// server actually did.
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
const broadcastsRepo = require('../src/repositories/broadcastsRepo');

let server, browser, page, baseUrl, testClientId;

const SUITE_PREFIX = '__test_suite__broadcastpauseresumeui_';
const EMAIL = `test-suite-broadcastpauseresumeui-${Date.now()}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';

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
  assert.ok(testClientId, 'dedicated test client registration must succeed');

  // Created directly (pool, no real send needed for a UI test) rather than
  // through the launch flow — that path is already covered end-to-end by
  // broadcastPauseResume.test.js and the New Campaign modal's own tests.
  await broadcastsRepo.create(pool, testClientId, {
    title: `${SUITE_PREFIX}Campaign`, tag_id: null, contact_list_id: null, segment_id: null,
    template_name: `${SUITE_PREFIX}t`, scheduled_date: null, param_mappings: {}, header_media_asset_id: null, pacing_config: null,
  });

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

test('1. a Sending campaign shows a Pause button; clicking it pauses for real, server-side', async () => {
  await page.click('.nav-item[data-view="campaigns"]');
  await page.waitForTimeout(500);

  const row = page.locator('#broadcasts-table-body tr', { hasText: `${SUITE_PREFIX}Campaign` });
  await assert.doesNotReject(row.locator('.broadcast-pause-btn').waitFor({ timeout: 3000 }));

  await row.locator('.broadcast-pause-btn').click();
  await page.waitForTimeout(500);

  const statusText = await row.locator('.status-badge').first().textContent();
  assert.equal(statusText.trim(), 'Paused');
  await assert.doesNotReject(row.locator('.broadcast-resume-btn').waitFor({ timeout: 3000 }));

  const broadcasts = await fetch(`${baseUrl}/api/broadcasts`, { headers: { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('client_token'))}` } }).then((r) => r.json());
  const found = broadcasts.find((b) => b.title === `${SUITE_PREFIX}Campaign`);
  assert.equal(found.status, 'Paused', 'the pause must have actually happened server-side, not just in the DOM');
});

test('2. resuming flips it back to Sending, server-side too', async () => {
  const row = page.locator('#broadcasts-table-body tr', { hasText: `${SUITE_PREFIX}Campaign` });
  await row.locator('.broadcast-resume-btn').click();
  await page.waitForTimeout(500);

  const statusText = await row.locator('.status-badge').first().textContent();
  assert.equal(statusText.trim(), 'Sending');
  await assert.doesNotReject(row.locator('.broadcast-pause-btn').waitFor({ timeout: 3000 }));

  const broadcasts = await fetch(`${baseUrl}/api/broadcasts`, { headers: { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('client_token'))}` } }).then((r) => r.json());
  const found = broadcasts.find((b) => b.title === `${SUITE_PREFIX}Campaign`);
  assert.equal(found.status, 'Sending');
});
