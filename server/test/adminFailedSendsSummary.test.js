// Admin failed sends summary (build-docs/features/admin-failed-sends-summary.md).
// Disposable __test_suite__ clients, deleted in after(). No Meta calls.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const PORT = 4000; // admin/app.js API_BASE targets :4000 unless served from it
process.env.ALLOWED_ORIGINS = `http://localhost:${PORT}`;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const apiKeysRepo = require('../src/repositories/apiKeysRepo');
const { ADMIN_EMAIL, ADMIN_PASSWORD } = require('./helpers/adminCredentials');

const BASE = `http://localhost:${PORT}`;
const PREFIX = '__test_suite__failedsends_';
let server, admin, clientId, otherClientId, emptyClientId;

async function makeClient(tag) {
  const { rows } = await pool.query(
    "insert into clients (name, email, status, tenant_slug) values ($1, $2, 'active', $3) returning id",
    [`${PREFIX}${tag}`, `test-failedsends-${tag}-${Date.now()}@wasi.local`, `test-failedsends-${tag}-${Date.now()}`]
  );
  return rows[0].id;
}
async function chat(cid, n) {
  const { rows } = await pool.query('insert into chats (client_id, name, phone) values ($1, $2, $3) returning id', [cid, `c${n}`, `9198000002${String(n).padStart(2, '0')}`]);
  return rows[0].id;
}
async function msg(cid, chatId, { body, status = 'failed', code = null, reason = null, apiKeyId = null, ago = '1 hour' }) {
  const { rows } = await pool.query(
    `insert into messages (chat_id, client_id, direction, body, status, meta_error_code, error_reason, api_key_id, sent_at)
     values ($1, $2, 'out', $3, $4, $5, $6, $7, now() - $8::interval) returning id`,
    [chatId, cid, body, status, code, reason, apiKeyId, ago]
  );
  return rows[0].id;
}

before(async () => {
  clientId = await makeClient('main');
  otherClientId = await makeClient('other');
  emptyClientId = await makeClient('empty');
  const key = await apiKeysRepo.create(pool, clientId, 'n8n');
  const [a, b, c] = [await chat(clientId, 1), await chat(clientId, 2), await chat(clientId, 3)];
  const early = '[template: mirai_early_bird]';
  // n8n retried 2 contacts: 3 attempts on a, 1 on b -> 4 attempts, 2 contacts.
  for (const ch of [a, a, a, b]) await msg(clientId, ch, { body: early, code: 132000, reason: '(#132000) Number of parameters does not match', apiKeyId: key.record.id });
  await msg(clientId, c, { body: early, code: 130429, reason: 'Rate limit hit', apiKeyId: key.record.id });
  // A campaign failure (Meta payment issue).
  const { rows: [bc] } = await pool.query("insert into broadcasts (client_id, title, status) values ($1, 'promo', 'Completed') returning id", [clientId]);
  const campaignMsg = await msg(clientId, c, { body: '[template: day_1_update]', code: 131042, reason: 'Business eligibility payment issue' });
  await pool.query("insert into broadcast_recipients (broadcast_id, client_id, message_id, status) values ($1, $2, $3, 'sent')", [bc.id, clientId, campaignMsg]);
  // Inbox text with an unknown code keeps the raw reason.
  await msg(clientId, a, { body: 'hello', code: 999999, reason: 'Some new Meta error' });
  // Excluded: delivered, older than 7 days, inbound, another client.
  await msg(clientId, b, { body: early, status: 'delivered' });
  await msg(clientId, b, { body: early, code: 132000, reason: 'old', apiKeyId: key.record.id, ago: '8 days' });
  await pool.query("insert into messages (chat_id, client_id, direction, body, status) values ($1, $2, 'in', 'hi', 'failed')", [b, clientId]);
  await msg(otherClientId, await chat(otherClientId, 9), { body: early, code: 132000, reason: 'other' });

  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  admin = await fetch(`${BASE}/api/admin/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }).then((r) => r.json());
  assert.ok(admin.token, 'admin login');
});

after(async () => {
  await pool.query('delete from clients where id = any($1)', [[clientId, otherClientId, emptyClientId].filter(Boolean)]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

const detail = (id) => fetch(`${BASE}/api/admin/clients/${id}`, { headers: { Authorization: `Bearer ${admin.token}` } }).then((r) => r.json());
const find = (rows, t, code) => rows.find((r) => r.template_name === t && r.meta_error_code === code);

test('AC1 groups by template + source + error with attempts and distinct contacts', async () => {
  const { failedSends } = await detail(clientId);
  const params = find(failedSends, 'mirai_early_bird', 132000);
  assert.equal(params.attempts, 4);
  assert.equal(params.contacts, 2);
  assert.equal(find(failedSends, 'mirai_early_bird', 130429).attempts, 1);
  assert.equal(failedSends[0].meta_error_code, 132000, 'most attempts first');
});

test('AC2 source is the API app name, Campaign, or Inbox / flow', async () => {
  const { failedSends } = await detail(clientId);
  assert.equal(find(failedSends, 'mirai_early_bird', 132000).source, 'n8n');
  assert.equal(find(failedSends, 'day_1_update', 131042).source, 'Campaign');
  assert.equal(find(failedSends, '(not a template)', 999999).source, 'Inbox / flow');
});

test('AC3 known codes get plain language, unknown keep the raw reason', async () => {
  const { failedSends } = await detail(clientId);
  assert.match(find(failedSends, 'day_1_update', 131042).explanation, /payment method/);
  assert.match(find(failedSends, 'mirai_early_bird', 132000).explanation, /parameter count/);
  assert.doesNotMatch(find(failedSends, 'mirai_early_bird', 130429).explanation, /retried automatically/);
  assert.equal(find(failedSends, '(not a template)', 999999).explanation, 'Some new Meta error');
});

test('AC4 excludes delivered, older than 7 days, inbound and other clients', async () => {
  const { failedSends } = await detail(clientId);
  assert.equal(failedSends.length, 4);
  assert.equal(failedSends.reduce((n, r) => n + r.attempts, 0), 7);
  assert.equal(failedSends.some((r) => r.error_reason === 'old' || r.error_reason === 'other'), false);
});

test('AC5 the Activity tab shows the table, or the empty state', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10000);
    await page.goto(`${BASE}/admin/`);
    await page.evaluate(([t, a]) => { localStorage.setItem('admin_token', t); localStorage.setItem('admin_profile', JSON.stringify(a)); }, [admin.token, admin.admin]);
    await page.goto(`${BASE}/admin/#client-detail/${clientId}?tab=activity`);
    await page.reload();
    await page.waitForSelector('#failed-sends-table tbody tr');
    assert.equal(await page.locator('#failed-sends-table tbody tr').count(), 4);
    const text = await page.locator('#failed-sends-table').innerText();
    assert.match(text, /mirai_early_bird/);
    assert.match(text, /Meta 131042/);

    await page.goto(`${BASE}/admin/#client-detail/${emptyClientId}?tab=activity`);
    await page.reload();
    await page.waitForSelector('#panel-client-activity >> text=No failed sends');
  } finally {
    await browser.close();
  }
});
