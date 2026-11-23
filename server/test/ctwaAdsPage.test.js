// Click-to-WhatsApp Ads page (build-docs/features/ctwa-ads-page.md).
// AC1 nav + deep link, AC2 per-ad lead/message counts + range filter,
// AC3 ad -> chats -> open chat, AC4 no clicks/spend/CPL anywhere,
// AC5 Agent gets 403 (server gate), AC6 empty state.
//
// Uses :4000 like every UI suite (app.js API_BASE assumes it); run serially.
// Seeds chats/messages for disposable __test_suite__ clients, deleted in after().
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const PORT = 4000;
process.env.ALLOWED_ORIGINS = `http://localhost:${PORT}`;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

const BASE = `http://localhost:${PORT}`;
const PREFIX = '__test_suite__ctwa_';
const STAMP = Date.now();
const EMAIL = `test-suite-ctwa-${STAMP}@wasi.local`;
const EMPTY_EMAIL = `test-suite-ctwa-empty-${STAMP}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';
const DAY = 86400000;
let server, browser, token, emptyToken, clientId;
const chatIds = {};

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

async function seedChat(key, name, phone, messages) {
  const { rows } = await pool.query('insert into chats (client_id, name, phone) values ($1, $2, $3) returning id', [clientId, name, phone]);
  chatIds[key] = rows[0].id;
  for (const m of messages) {
    await pool.query(
      `insert into messages (chat_id, client_id, direction, body, sent_at, referral) values ($1, $2, 'in', 'hi', $3, $4)`,
      [rows[0].id, clientId, new Date(Date.now() - m.daysAgo * DAY), m.referral ? JSON.stringify(m.referral) : null]
    );
  }
}

const AD_A = { source_id: `${PREFIX}ad_a`, headline: 'Summer Sale', source_type: 'ad', source_url: 'https://fb.me/summer' };
const AD_B = { source_id: `${PREFIX}ad_b`, headline: 'Free Demo', source_type: 'ad', source_url: 'javascript:alert(1)' };

before(async () => {
  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  const login = await register(EMAIL);
  token = login.token;
  clientId = (await pool.query('select id from clients where email = $1', [EMAIL])).rows[0].id;
  emptyToken = (await register(EMPTY_EMAIL)).token;
  // Ad A: 2 chats (one sent 2 ad messages); Ad B: 1 chat 40 days ago;
  // one organic chat that must never be counted.
  await seedChat('a1', 'Asha', '919000000001', [{ daysAgo: 1, referral: AD_A }, { daysAgo: 1, referral: AD_A }]);
  await seedChat('a2', 'Bala', '919000000002', [{ daysAgo: 3, referral: AD_A }]);
  await seedChat('b1', 'Chitra', '919000000003', [{ daysAgo: 40, referral: AD_B }]);
  await seedChat('organic', 'Dev', '919000000004', [{ daysAgo: 1, referral: null }]);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await pool.query('delete from clients where email = any($1)', [[EMAIL, EMPTY_EMAIL]]).catch(() => {});
  await pool.end();
});

const api = (path, t = token) => fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${t}` } });

test('AC2 server: leads are distinct chats per ad, totals do not double count, organic excluded', async () => {
  const body = await api('/api/analytics/ctwa').then((r) => r.json());
  assert.deepEqual(body.totals, { leads: 3, messages: 4, ads: 2 });
  const a = body.bySource.find((r) => r.sourceId === AD_A.source_id);
  assert.equal(a.leadCount, 2);
  assert.equal(a.messageCount, 3);
  assert.equal(a.sourceUrl, AD_A.source_url);
  assert.equal(body.bySource[0].sourceId, AD_A.source_id, 'sorted by leads');

  const since = new Date(Date.now() - 30 * DAY).toISOString();
  const recent = await api(`/api/analytics/ctwa?since=${encodeURIComponent(since)}`).then((r) => r.json());
  assert.deepEqual(recent.totals, { leads: 2, messages: 3, ads: 1 }, 'the 40-day-old ad falls outside 30 days');

  assert.equal((await api('/api/analytics/ctwa?since=not-a-date')).status, 400);
});

test('AC3 server: chats for one ad, and an ad with no source_id/headline is still openable', async () => {
  const q = new URLSearchParams({ sourceId: AD_A.source_id, headline: AD_A.headline });
  const { chats } = await api(`/api/analytics/ctwa/chats?${q}`).then((r) => r.json());
  assert.deepEqual(chats.map((c) => c.name).sort(), ['Asha', 'Bala']);
  assert.equal(chats.find((c) => c.name === 'Asha').messageCount, 2);

  await seedChat('unnamed', 'Esha', '919000000005', [{ daysAgo: 2, referral: { source_type: 'post' } }]);
  const unnamed = await api('/api/analytics/ctwa/chats').then((r) => r.json());
  assert.deepEqual(unnamed.chats.map((c) => c.name), ['Esha']);
  await pool.query('delete from chats where id = $1', [chatIds.unnamed]);
});

test('AC6 server + AC5: empty client gets zeros; tenant isolation holds', async () => {
  const body = await api('/api/analytics/ctwa', emptyToken).then((r) => r.json());
  assert.deepEqual(body, {
    totals: { leads: 0, messages: 0, ads: 0 },
    adsAccount: { connected: false, hasMetrics: false, error: null, currency: null },
    bySource: [],
  });
  const q = new URLSearchParams({ sourceId: AD_A.source_id, headline: AD_A.headline });
  const other = await api(`/api/analytics/ctwa/chats?${q}`, emptyToken).then((r) => r.json());
  assert.deepEqual(other.chats, [], "another client's ad chats are never visible");
});

test('AC5: the route is behind the Admin/Manager gate', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'analytics.js'), 'utf8');
  assert.match(src, /router\.use\(requireRole\('Admin', 'Manager'\)\);/);
  assert.ok(src.indexOf("router.use(requireRole('Admin', 'Manager'))") < src.indexOf("router.get('/ctwa'"), 'gate is applied before the ctwa routes');
});

async function openApp(t, hash) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${BASE}/app`);
  await page.evaluate((tk) => { localStorage.setItem('client_token', tk); localStorage.setItem('actor_type', 'owner'); }, t);
  await page.goto(`${BASE}/app#${hash}`);
  await page.reload();
  await page.waitForSelector(`#view-${hash}.active`);
  return page;
}

test('AC1-AC4 UI: nav opens the page, tiles + table, range filter, drill into chats, open a chat', async () => {
  const page = await openApp(token, 'ctwa');
  const nav = page.locator('.nav-item[data-view="ctwa"]');
  assert.equal(await nav.locator('.nav-soon').count(), 0, 'no longer marked Soon');

  await page.waitForSelector('#ctwa-ads-tbody tr.ctwa-ad-row');
  assert.equal(await page.locator('#ctwa-ads-tbody tr.ctwa-ad-row').count(), 1, 'default 30 days shows Ad A only');
  assert.match(await page.locator('#ctwa-stats').innerText(), /2[\s\S]*1[\s\S]*3/);

  await page.selectOption('#ctwa-range', 'all');
  await page.waitForFunction(() => document.querySelectorAll('#ctwa-ads-tbody tr.ctwa-ad-row').length === 2);
  // Unsafe ad link (javascript:) is never rendered as a link.
  const hrefs = await page.$$eval('#ctwa-ads-tbody a', (as) => as.map((a) => a.getAttribute('href')));
  assert.deepEqual(hrefs, [AD_A.source_url]);

  const text = await page.locator('#view-ctwa').innerText();
  // No ad account connected: spend/clicks/cost per lead are never invented
  // (ctwa-ad-metrics.md). The columns show "-" and there is no spend tile.
  assert.ok(text.length);
  assert.doesNotMatch(await page.locator('#ctwa-stats').innerText(), /Ad spend|Cost per lead/);
  const moneyCells = await page.$$eval('#ctwa-ads-tbody td[data-label="Spend"], #ctwa-ads-tbody td[data-label="Clicks"], #ctwa-ads-tbody td[data-label="Cost per lead"]', (tds) => tds.map((t) => t.innerText.trim()));
  assert.ok(moneyCells.length && moneyCells.every((v) => v === '-'), JSON.stringify(moneyCells));

  await page.click('#ctwa-ads-tbody tr.ctwa-ad-row >> text=Summer Sale');
  await page.waitForSelector('#ctwa-chats-tbody [data-ctwa-open-chat]');
  assert.equal(await page.locator('#ctwa-chats-tbody [data-ctwa-open-chat]').count(), 2);
  assert.equal(await page.locator('#ctwa-chats-title').innerText(), 'Summer Sale');

  await page.click(`[data-ctwa-open-chat="${chatIds.a1}"]`);
  await page.waitForSelector('#view-chat.active');
  await page.waitForFunction(() => /Asha/.test(document.querySelector('#view-chat').innerText));
  assert.equal(await page.evaluate(() => location.hash), '#chat');
  await page.close();
});

test('AC6 UI: a client with no ad chats sees the empty state, not fake numbers', async () => {
  const page = await openApp(emptyToken, 'ctwa');
  await page.waitForFunction(() => /No chats from ads yet/.test(document.getElementById('ctwa-ads-tbody').innerText));
  await page.close();
});
