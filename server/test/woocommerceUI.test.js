// Ecommerce page (WooCommerce) in a real browser
// (build-docs/features/woocommerce-integration.md, AC6). The fake store and
// fake Meta are served by stubbing global.fetch in this process (the server
// runs here via createApp); DNS for the fake host via publicUrl.resolver.
//
// Uses :4000 like every UI suite (app.js API_BASE assumes it); run serially.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const PORT = 4000;
process.env.ALLOWED_ORIGINS = `http://localhost:${PORT}`;
process.env.APP_URL = 'https://wasi.test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { encrypt, decrypt } = require('../src/utils/encryption');
const publicUrl = require('../src/utils/publicUrl');

const BASE = `http://localhost:${PORT}`;
const PREFIX = '__test_suite__wooui_';
const EMAIL = `test-suite-wooui-${Date.now()}@wasi.local`;
let server, browser, token, clientId;
const realFetch = global.fetch;
const realLookup = publicUrl.resolver.lookup;
const storeCalls = [];
let seq = 900;

before(async () => {
  publicUrl.resolver.lookup = async (host) => (host === 'myshop.test' ? [{ address: '93.184.216.34' }] : realLookup(host));
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://myshop.test/')) {
      storeCalls.push({ url: u, method: opts.method || 'GET' });
      return new Response(JSON.stringify(opts.method === 'POST' ? { id: ++seq } : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('graph.facebook.com')) {
      return new Response(JSON.stringify({ messages: [{ id: `wamid.wooui${++seq}` }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  const reg = await realFetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${PREFIX}client`, email: EMAIL, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  token = reg.token;
  clientId = reg.client.id;
  await pool.query(
    `insert into wabas (client_id, waba_id, phone_number_id, status, access_token_encrypted) values ($1, $2, $3, 'connected', $4)`,
    [clientId, `${PREFIX}waba_${Date.now()}`, `${PREFIX}phone`, encrypt('fake-token')]
  );
  await pool.query(
    `insert into message_templates (client_id, name, category, status, body, language) values
      ($1, 'order_update', 'UTILITY', 'approved', 'Hi {{first_name}}, order {{order_no}} is now {{order_status}}.', 'en'),
      ($1, 'promo', 'MARKETING', 'approved', 'Sale!', 'en')`,
    [clientId]
  );
  browser = await chromium.launch();
});

after(async () => {
  global.fetch = realFetch;
  publicUrl.resolver.lookup = realLookup;
  await browser?.close();
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

async function openApp(hash, width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${BASE}/app`);
  await page.evaluate((t) => { localStorage.setItem('client_token', t); localStorage.setItem('actor_type', 'owner'); }, token);
  await page.goto(`${BASE}/app#${hash}`);
  await page.reload();
  await page.waitForSelector(`#view-${hash}.active`);
  return page;
}

test('connect with keys, set up a message, see an order event, disconnect', async () => {
  const page = await openApp('ecommerce');
  assert.equal(await page.locator('.nav-item[data-view="ecommerce"] .nav-soon').count(), 0, 'no longer Soon');
  await page.waitForSelector('#woo-connect-card:not([hidden])');

  // A private address is refused with a readable reason.
  await page.click('.woo-keys summary');
  await page.fill('#woo-key-url', 'https://127.0.0.1');
  await page.fill('#woo-key-ck', `ck_${'a'.repeat(40)}`);
  await page.fill('#woo-key-cs', `cs_${'b'.repeat(40)}`);
  await page.click('#woo-keys-form button[type="submit"]');
  await page.waitForSelector('#woo-connect-error:not([hidden])');
  assert.match(await page.locator('#woo-connect-error').innerText(), /not reachable/);

  await page.fill('#woo-key-url', 'https://myshop.test');
  await page.click('#woo-keys-form button[type="submit"]');
  await page.waitForSelector('#woo-connected:not([hidden])');
  assert.equal(await page.locator('#woo-store-name').innerText(), 'myshop.test');
  assert.equal(storeCalls.filter((c) => c.method === 'POST').length, 2, 'two webhooks created on the store');

  // Rule drawer: only the approved Utility template is offered; variables auto-map by name.
  await page.click('[data-woo-rule="status_completed"]');
  await page.waitForSelector('#modal-woo-rule.open');
  const options = await page.$$eval('#woo-rule-template option', (os) => os.map((o) => o.value).filter(Boolean));
  assert.deepEqual(options, ['order_update']);
  await page.selectOption('#woo-rule-template', 'order_update');
  await page.waitForSelector('[data-woo-var="order_no"]');
  assert.equal(await page.inputValue('[data-woo-var="first_name"]'), 'first_name', 'same-named field picked automatically');
  await page.selectOption('[data-woo-var="order_no"]', 'order_number');
  await page.click('#woo-rule-form button[type="submit"]');
  await page.waitForFunction(() => /order_update/.test(document.getElementById('woo-rules-tbody').innerText));

  // A signed "order completed" event from the store.
  const store = (await pool.query('select id, webhook_secret_encrypted from ecommerce_stores where client_id = $1', [clientId])).rows[0];
  const body = JSON.stringify({ id: 77, number: '77', status: 'completed', total: '499', currency: 'INR', billing: { first_name: 'Ravi', phone: '9000000077', country: 'IN' } });
  const sig = crypto.createHmac('sha256', decrypt(store.webhook_secret_encrypted)).update(body).digest('base64');
  const res = await realFetch(`${BASE}/webhooks/woocommerce/${store.id}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-WC-Webhook-Topic': 'order.updated', 'X-WC-Webhook-Signature': sig } });
  assert.equal(res.status, 200);
  for (let i = 0; i < 30; i++) {
    const r = (await pool.query(`select status from ecommerce_events where store_id = $1`, [store.id])).rows[0];
    if (r && r.status !== 'received') break;
    await new Promise((x) => setTimeout(x, 100));
  }
  await page.reload();
  await page.waitForSelector('#view-ecommerce.active');
  await page.waitForFunction(() => /#77/.test(document.getElementById('woo-events-tbody').innerText));
  assert.match(await page.locator('#woo-events-tbody').innerText(), /Sent/);

  await page.click('#woo-disconnect-btn');
  await page.click('#modal-confirm-action-btn');
  await page.waitForSelector('#woo-connect-card:not([hidden])');
  assert.equal((await pool.query('select count(*)::int n from ecommerce_stores where client_id = $1', [clientId])).rows[0].n, 0);
  await page.close();
});

test('Integrations shows the WooCommerce card and its button opens Ecommerce', async () => {
  const page = await openApp('integrations');
  await page.waitForSelector('.integration-name:text("WooCommerce")');
  const card = page.locator('.integration-card', { has: page.locator('.integration-name', { hasText: 'WooCommerce' }) });
  assert.equal(await card.locator('.badge').innerText(), 'Not set up');
  await card.locator('button').click();
  await page.waitForSelector('#view-ecommerce.active');
  await page.close();
});

test('Ecommerce page fits a 375px phone', async () => {
  const page = await openApp('ecommerce', 375);
  await page.waitForSelector('#woo-connect-card:not([hidden])');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.close();
});
