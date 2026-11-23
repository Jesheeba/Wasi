// Integrations page (build-docs/features/integrations-page.md).
// AC1 cards reflect real DB state, AC2 Configure buttons land on the right
// place, AC3 Shopify is "Coming soon" with no action, AC4 no secret/hash in
// the response, AC5 Agent is gated (server) and hidden (nav).
//
// Uses :4000 like every UI suite (app.js API_BASE assumes it); run serially.
// Seeds rows for disposable __test_suite__ clients, deleted in after().
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
const PREFIX = '__test_suite__integrations_';
const STAMP = Date.now();
const EMAIL = `test-suite-integrations-${STAMP}@wasi.local`;
const EMPTY_EMAIL = `test-suite-integrations-empty-${STAMP}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';
const HOOK_URL = 'https://example.com/wasi-hook';
const ZAP_URL = 'https://hooks.zapier.com/hooks/standard/1/abc';
const ZAP_SECRET = `${PREFIX}zap_secret_value`;
let server, browser, token, emptyToken, clientId, rawKey, hookSecret;

async function register(email) {
  await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${PREFIX}client`, email, password: PASSWORD }),
  });
  return fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  }).then((r) => r.json());
}
const call = (p, opts = {}, t = token) => fetch(`${BASE}${p}`, {
  ...opts, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
});

before(async () => {
  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  token = (await register(EMAIL)).token;
  emptyToken = (await register(EMPTY_EMAIL)).token;
  clientId = (await pool.query('select id from clients where email = $1', [EMAIL])).rows[0].id;

  const waba = (await pool.query(`insert into wabas (client_id, status) values ($1, 'connected') returning id`, [clientId])).rows[0].id;
  const key = await call('/api/api-keys', { method: 'POST', body: JSON.stringify({ app_name: `${PREFIX}zapier` }) }).then((r) => r.json());
  rawKey = key.key || key.api_key || key.rawKey;
  const keyId = key.id || (await pool.query('select id from api_keys where client_id = $1', [clientId])).rows[0].id;
  const hook = await call('/api/client-webhook', { method: 'POST', body: JSON.stringify({ callback_url: HOOK_URL, events: ['message.received'] }) }).then((r) => r.json());
  hookSecret = hook.secret;
  await pool.query(
    `insert into zapier_subscriptions (client_id, api_key_id, target_url, secret, event) values ($1, $2, $3, $4, 'message.received')`,
    [clientId, keyId, ZAP_URL, ZAP_SECRET]
  );
  // Webhook: older delivered then a newer failed one -> card shows Failing.
  // Zapier: one delivered.
  const d = (url, status, minsAgo, err = null) => pool.query(
    `insert into webhook_deliveries (client_id, waba_id, event, payload, target_url, target_secret, status, created_at, delivered_at, last_error)
     values ($1, $2, 'message.received', '{}', $3, 'x', $4, now() - ($5 || ' minutes')::interval, case when $4 = 'delivered' then now() - ($5 || ' minutes')::interval end, $6)`,
    [clientId, waba, url, status, String(minsAgo), err]
  );
  await d(HOOK_URL, 'delivered', 60);
  await d(HOOK_URL, 'failed', 5, 'HTTP 500 from receiver');
  await d(ZAP_URL, 'delivered', 10);
  await pool.query(`insert into payment_links (client_id, title, amount_inr) values ($1, 'Fee', 500), ($1, 'Deposit', 1000)`, [clientId]);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await pool.query('delete from clients where email = any($1)', [[EMAIL, EMPTY_EMAIL]]).catch(() => {});
  await pool.end();
});

test('AC1 + AC4: status reflects real rows and never carries a secret', async () => {
  const res = await call('/api/integrations/status');
  assert.equal(res.status, 200);
  const text = await res.text();
  const st = JSON.parse(text);
  assert.equal(st.whatsappConnected, true);
  assert.equal(st.webhook.configured, true);
  assert.equal(st.webhook.lastDelivery.status, 'failed', 'the newest delivery wins');
  assert.equal(st.webhook.lastDelivery.error, 'HTTP 500 from receiver');
  assert.equal(st.zapier.activeZaps, 1);
  assert.equal(st.zapier.lastDelivery.status, 'delivered', 'Zapier deliveries are told apart from the webhook by URL');
  assert.equal(st.api.activeKeys, 1);
  assert.equal(st.paymentLinks.created, 2);

  const hash = (await pool.query('select key_hash from api_keys where client_id = $1', [clientId])).rows[0].key_hash;
  for (const secret of [ZAP_SECRET, hookSecret, hash, rawKey].filter(Boolean)) {
    assert.equal(text.includes(secret), false, 'no secret, hash or raw key in the response');
  }
  assert.doesNotMatch(text, /secret|key_hash|callback_url|target_url/i);
});

test('AC1: an empty client gets an honest all-off status', async () => {
  const st = await call('/api/integrations/status', {}, emptyToken).then((r) => r.json());
  assert.deepEqual(st, {
    whatsappConnected: false,
    webhook: { configured: false, events: [], lastDelivery: null },
    zapier: { activeZaps: 0, lastDelivery: null },
    api: { activeKeys: 0, lastUsedAt: null },
    paymentLinks: { created: 0, lastCreatedAt: null },
  });
});

test('AC5: route is Admin/Manager only; nav hidden for Agent', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'integrations.js'), 'utf8');
  assert.match(route, /router\.use\(requireRole\('Admin', 'Manager'\)\);/);
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
  assert.match(appJs.match(/const agentHiddenViews = \[([^\]]+)\]/)[1], /'integrations'/);
});

async function openIntegrations(t) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${BASE}/app`);
  await page.evaluate((tk) => { localStorage.setItem('client_token', tk); localStorage.setItem('actor_type', 'owner'); }, t);
  await page.goto(`${BASE}/app#integrations`);
  await page.reload();
  await page.waitForSelector('#integrations-grid .integration-name');
  return page;
}
const card = (page, name) => page.locator('.integration-card', { has: page.locator('.integration-name', { hasText: name }) });

test('AC1-AC3 UI: cards, badges, Shopify coming soon, buttons navigate', async () => {
  const page = await openIntegrations(token);
  assert.equal(await page.locator('.nav-item[data-view="integrations"] .nav-soon').count(), 0, 'no longer marked Soon');
  assert.equal(await page.locator('#integrations-no-waba').isHidden(), true);
  assert.equal(await card(page, 'Webhooks').locator('.badge').innerText(), 'Failing');
  assert.match(await card(page, 'Webhooks').innerText(), /Last delivery failed/);
  assert.equal(await card(page, 'Zapier').locator('.badge').innerText(), 'Connected');
  assert.match(await card(page, 'Zapier').innerText(), /1 active Zap\b/);
  assert.match(await card(page, 'API & AI assistants').innerText(), /1 active key\b/);
  assert.match(await card(page, 'Razorpay').innerText(), /2 links created/);
  assert.equal(await card(page, 'Shopify').locator('.badge').innerText(), 'Coming soon');
  assert.equal(await card(page, 'Shopify').locator('button').count(), 0, 'no fake connect action');

  await card(page, 'Webhooks').locator('button').click();
  await page.waitForSelector('#view-settings.active');
  await page.waitForFunction(() => document.querySelector('.sec-nav-item[data-sec-view="webhook"]').classList.contains('active'));

  await page.goto(`${BASE}/app#integrations`);
  await page.waitForSelector('#integrations-grid .integration-name');
  await card(page, 'API & AI assistants').locator('button').click();
  await page.waitForFunction(() => document.querySelector('.sec-nav-item[data-sec-view="developer"]').classList.contains('active'));

  await page.goto(`${BASE}/app#integrations`);
  await page.waitForSelector('#integrations-grid .integration-name');
  await card(page, 'Razorpay').locator('button').click();
  await page.waitForSelector('#view-payments.active');
  await page.close();
});

test('AC1 UI: an empty client sees Not set up and the connect-WhatsApp notice', async () => {
  const page = await openIntegrations(emptyToken);
  assert.equal(await page.locator('#integrations-no-waba').isVisible(), true);
  assert.equal(await card(page, 'Webhooks').locator('.badge').innerText(), 'Not set up');
  assert.equal(await card(page, 'Zapier').locator('.badge').innerText(), 'Not set up');
  await page.close();
});
