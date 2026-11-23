// WhatsApp quick wins in a real browser (build-docs/features/whatsapp-quick-wins.md).
// Meta faked by stubbing global.fetch in this process (server via createApp).
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
const PREFIX = '__test_suite__qwui_';
const EMAIL = `test-suite-qwui-${Date.now()}@wasi.local`;
let server, browser, token, clientId, chatId;
const metaCalls = [];
const realFetch = global.fetch;

before(async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    metaCalls.push({ url: u, method: opts.method || 'GET', body });
    let reply = { success: true };
    if (u.includes('fields=conversational_automation')) reply = { conversational_automation: { enable_welcome_message: false, prompts: ['Fees?'], commands: [] } };
    else if (u.includes('fields=official_business_account')) reply = { official_business_account: { oba_status: 'NOT_STARTED' } };
    else if (u.includes('/message_qrdls') && body?.generate_qr_image) reply = { code: 'QR1', prefilled_message: body.prefilled_message, deep_link_url: 'https://wa.me/message/QR1', qr_image_url: 'data:image/png;base64,iVBORw0KGgo=' };
    else if (u.includes('/block_users')) reply = { block_users: { added_users: [{ input: '+919092766740' }] } };
    else if (u.includes('whatsapp_business_profile')) reply = { data: [{ about: 'Hi' }] };
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
    `insert into wabas (client_id, waba_id, phone_number_id, status, access_token_encrypted, display_phone_number, display_name, registration_is_on_biz_app)
     values ($1, $2, $3, 'connected', $4, '+91 73395 61631', 'Wasi Demo', false)`,
    [clientId, `${PREFIX}waba_${Date.now()}`, `${PREFIX}phone`, encrypt('fake-token')]
  );
  const contactId = (await pool.query(`insert into contacts (client_id, name, phone) values ($1, 'QW Tester', '919092766740') returning id`, [clientId])).rows[0].id;
  chatId = (await pool.query(`insert into chats (client_id, name, phone, contact_id) values ($1, 'QW Tester', '919092766740', $2) returning id`, [clientId, contactId])).rows[0].id;
  await pool.query(`insert into messages (chat_id, client_id, direction, body, sent_at, meta_message_id) values ($1, $2, 'in', 'hello', now() - interval '2 minutes', 'wamid.qwui1')`, [chatId, clientId]);
  browser = await chromium.launch();
});

after(async () => {
  global.fetch = realFetch;
  await browser?.close();
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

async function openApp(hash) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${BASE}/app`);
  await page.evaluate((t) => { localStorage.setItem('client_token', t); localStorage.setItem('actor_type', 'owner'); }, token);
  await page.goto(`${BASE}/app#${hash}`);
  await page.reload();
  await page.waitForSelector(`#view-${hash}.active`);
  return page;
}

test('chat: opening sends read ticks; typing sends the indicator once; Block works from the menu', async () => {
  const page = await openApp('chat');
  await page.waitForSelector(`[data-chat-id="${chatId}"]`);
  await page.click(`[data-chat-id="${chatId}"]`);
  await page.waitForFunction(() => /hello/.test(document.querySelector('#view-chat').innerText));
  await page.waitForFunction(() => true);
  for (let i = 0; i < 20 && !metaCalls.some((c) => c.body?.status === 'read'); i++) await page.waitForTimeout(100);
  const read = metaCalls.find((c) => c.body?.status === 'read');
  assert.equal(read.body.message_id, 'wamid.qwui1');
  assert.equal(read.body.typing_indicator, undefined);

  await page.type('#chat-message-input', 'Hello the');
  for (let i = 0; i < 20 && !metaCalls.some((c) => c.body?.typing_indicator); i++) await page.waitForTimeout(100);
  assert.equal(metaCalls.filter((c) => c.body?.typing_indicator).length, 1, 'throttled to one call');

  await page.click('#chat-more-menu-btn');
  await page.waitForFunction(() => /Block contact/.test(document.getElementById('chat-block-btn').innerText));
  await page.click('#chat-block-btn');
  await page.click('#modal-confirm-action-btn');
  for (let i = 0; i < 20 && !metaCalls.some((c) => c.url.includes('block_users')); i++) await page.waitForTimeout(100);
  await page.click('#chat-more-menu-btn');
  await page.waitForFunction(() => /Unblock contact/.test(document.getElementById('chat-block-btn').innerText));
  await page.close();
});

test('settings: create a QR code and save conversation starters; green tick status shows', async () => {
  const page = await openApp('settings');
  await page.click('.inner-tab-btn[data-inner-tab="message-link"]');
  await page.waitForSelector('#wa-qr-form');
  await page.fill('#wa-qr-message', 'Hi, I saw your poster');
  await page.click('#wa-qr-form button[type="submit"]');
  await page.waitForFunction(() => /wa\.me\/message\/QR1/.test(document.getElementById('wa-qr-list').innerText));
  assert.equal(await page.locator('#wa-qr-list img.wa-qr-img').count(), 1);

  await page.click('.inner-tab-btn[data-inner-tab="channel-settings"]');
  await page.waitForSelector('#wa-cmd-add');
  assert.equal(await page.inputValue('[data-prompt] >> nth=0'), 'Fees?');
  await page.fill('[data-prompt] >> nth=1', 'Batch timings?');
  await page.click('#wa-cmd-add');
  await page.fill('#wa-cmd-list [data-cmd-name]', '/hours');
  await page.fill('#wa-cmd-list [data-cmd-desc]', 'Our opening hours');
  await page.click('#wa-starters-form button[type="submit"]');
  for (let i = 0; i < 20 && !metaCalls.some((c) => c.url.endsWith('/conversational_automation') && c.method === 'POST'); i++) await page.waitForTimeout(100);
  const saved = metaCalls.find((c) => c.url.endsWith('/conversational_automation') && c.method === 'POST').body;
  assert.deepEqual(saved.prompts, ['Fees?', 'Batch timings?']);
  assert.deepEqual(saved.commands, [{ command_name: 'hours', command_description: 'Our opening hours' }]);

  await page.waitForFunction(() => /not started/i.test(document.getElementById('wa-green-tick-body').innerText));
  assert.equal(await page.locator('#wa-oba-form').count(), 1);
  await page.close();
});
