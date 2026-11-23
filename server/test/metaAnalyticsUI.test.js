// Analytics > WhatsApp cost and Template performance tabs, in a real browser
// (build-docs/features/meta-analytics.md). Meta faked via global.fetch.
// Uses :4000 like every UI suite (app.js API_BASE assumes it); run serially.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const PORT = 4000;
process.env.ALLOWED_ORIGINS = `http://localhost:${PORT}`;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { encrypt } = require('../src/utils/encryption');

const BASE = `http://localhost:${PORT}`;
const EMAIL = `test-suite-metaanui-${Date.now()}@wasi.local`;
let server, browser, token, clientId;
const metaCalls = [];
const realFetch = global.fetch;

before(async () => {
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    metaCalls.push({ url: u, method: opts.method || 'GET' });
    let body = { success: true };
    if (u.includes('pricing_analytics')) body = { pricing_analytics: { data: [{ data_points: [{ start: 1763596800, end: 1763683200, pricing_category: 'MARKETING', pricing_type: 'REGULAR', volume: 4, cost: 3.14 }] }] } };
    if (u.includes('/template_analytics')) body = { data: [{ data_points: [{ template_id: '7001', sent: 9, delivered: 8, read: 6, clicked: [], cost: [{ type: 'amount_spent', value: 1.2 }] }] }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  const reg = await realFetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: '__test_suite__metaanui_client', email: EMAIL, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  token = reg.token;
  clientId = reg.client.id;
  await pool.query(`insert into wabas (client_id, waba_id, phone_number_id, status, access_token_encrypted) values ($1, 'w_ui', 'p_ui', 'connected', $2)`, [clientId, encrypt('fake-token')]);
  await pool.query(`insert into message_templates (client_id, name, category, status, body, language, meta_template_id) values ($1, 'order_update', 'UTILITY', 'approved', 'x', 'en', '7001')`, [clientId]);
  browser = await chromium.launch();
});

after(async () => {
  global.fetch = realFetch;
  await browser?.close();
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

test('cost tab shows Meta totals; template tab needs the confirm box before turning on', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${BASE}/app`);
  await page.evaluate((t) => { localStorage.setItem('client_token', t); localStorage.setItem('actor_type', 'owner'); }, token);
  await page.goto(`${BASE}/app#analytics`);
  await page.reload();
  await page.waitForSelector('#view-analytics.active');

  await page.click('#rep-tab-cost');
  await page.waitForFunction(() => /3\.14/.test(document.getElementById('meta-cost-tiles').innerText));
  assert.match(await page.locator('#meta-cost-category-tbody').innerText(), /Marketing/);

  await page.click('#rep-tab-templates');
  await page.waitForSelector('#template-insights-off:not([hidden])');
  assert.equal(await page.locator('#template-insights-enable').isDisabled(), true, 'cannot turn on without ticking the box');
  await page.check('#template-insights-confirm');
  await page.click('#template-insights-enable');
  await page.waitForFunction(() => /order_update/.test(document.getElementById('template-insights-tbody').innerText));
  assert.match(await page.locator('#template-insights-tbody').innerText(), /9[\s\S]*8[\s\S]*6/);
  assert.ok(metaCalls.some((c) => c.method === 'POST' && c.url.endsWith('/w_ui')), 'the one-way switch was sent');
  await page.close();
});
