// Placeholder pages listed as "Coming soon" (build-docs/PLAN.md, 2026-11-23).
// Each planned page is reachable from the nav, carries a "Soon" badge, shows a
// Coming soon state, and contains none of the fake figures the old hidden
// placeholders used to show. Management pages are hidden from the Agent role.
//
// Uses :4000 like every UI suite (app.js API_BASE assumes it); run serially.
// Writes only to a disposable __test_suite__ client, deleted in after().
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const PORT = 4000;
process.env.ALLOWED_ORIGINS = `http://localhost:${PORT}`;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

const BASE = `http://localhost:${PORT}`;
const EMAIL = `test-suite-comingsoon-${Date.now()}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';
const SOON = ['instagram', 'whatsapp-flows', 'ecommerce', 'integrations'];
const MANAGEMENT = ['whatsapp-flows', 'ctwa', 'ecommerce', 'integrations'];
let server, browser, token;

before(async () => {
  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: '__test_suite__comingsoon_client', email: EMAIL, password: PASSWORD }),
  });
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json());
  token = login.token;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await pool.query('delete from clients where email = $1', [EMAIL]).catch(() => {});
  await pool.end();
});

async function openApp(hash = 'chat') {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${BASE}/app`);
  await page.evaluate((t) => { localStorage.setItem('client_token', t); localStorage.setItem('actor_type', 'owner'); }, token);
  await page.goto(`${BASE}/app#${hash}`);
  await page.reload();
  await page.waitForSelector('#app-shell', { state: 'visible' });
  return page;
}

test('every planned page is in the nav with a Soon badge and opens a Coming soon view', async () => {
  const page = await openApp();
  for (const view of SOON) {
    const nav = page.locator(`.nav-item[data-view="${view}"]`);
    assert.equal(await nav.count(), 1, `${view} has a nav entry`);
    assert.equal((await nav.locator('.nav-soon').textContent()).trim(), 'Soon');
    await nav.click();
    await page.waitForSelector(`#view-${view}.active`);
    assert.equal(await page.evaluate(() => location.hash), `#${view}`, 'deep link updates');
    const text = await page.locator(`#view-${view}`).innerText();
    assert.match(text, /coming soon/i, `${view} says coming soon`);
  }
  await page.close();
});

test('no fake data survives on the placeholder pages', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  for (const fake of ['1,420', '₹ 14.20', 'Classic Cotton T-Shirt', 'Submissions: 342', 'Special 5% Discount Coupon', 'sync-catalog-btn']) {
    assert.equal(html.includes(fake), false, `"${fake}" removed`);
  }
});

// applyRoleGating lives inside app.js's closure, so this checks its list
// directly; the nav hiding itself is the same loop Campaigns/Analytics use.
test('management pages are hidden from the Agent role, Instagram is not', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
  const list = src.match(/const agentHiddenViews = \[([^\]]+)\]/)[1];
  for (const v of MANAGEMENT) assert.ok(list.includes(`'${v}'`), `${v} hidden for Agent`);
  assert.equal(list.includes("'instagram'"), false, 'Instagram (an inbox) stays visible');
});
