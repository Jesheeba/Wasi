// Forms page + chat "Send form" (build-docs/features/whatsapp-flows.md), in a
// real browser. Meta is faked by stubbing global.fetch for graph.facebook.com
// in this process (the server runs here via createApp), so nothing is sent.
//
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
const PREFIX = '__test_suite__waflowsui_';
const EMAIL = `test-suite-waflowsui-${Date.now()}@wasi.local`;
let server, browser, token, clientId, chatId;
const metaCalls = [];
const realFetch = global.fetch;

before(async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    metaCalls.push({ url: u, method: opts.method || 'GET', body: opts.body });
    let body = { success: true };
    if (/\/flows$/.test(u)) body = { id: `meta_ui_${metaCalls.length}`, success: true, validation_errors: [] };
    if (/\/messages$/.test(u)) body = { messages: [{ id: `wamid.ui${metaCalls.length}` }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  chatId = (await pool.query(`insert into chats (client_id, name, phone) values ($1, 'Form Tester', '919092766740') returning id`, [clientId])).rows[0].id;
  await pool.query(`insert into messages (chat_id, client_id, direction, body, sent_at) values ($1, $2, 'in', 'hello', now() - interval '5 minutes')`, [chatId, clientId]);
  browser = await chromium.launch();
});

after(async () => {
  global.fetch = realFetch;
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

test('Forms page: empty state, create a booking form with live preview, publish it', async () => {
  const page = await openApp('whatsapp-flows');
  assert.equal(await page.locator('.nav-item[data-view="whatsapp-flows"] .nav-soon').count(), 0, 'no longer Soon');
  await page.waitForFunction(() => /No forms yet/.test(document.getElementById('wa-forms-tbody').innerText));

  await page.click('#open-wa-form-drawer');
  await page.waitForSelector('#modal-wa-form.open');
  await page.click('label.option-card:has(input[value="booking"])');
  await page.waitForSelector('[data-wa-field="slot"]');
  await page.fill('#wa-form-name', 'Wasi Demo Booking');
  await page.fill('#wa-field-service-opts', 'Haircut\nBeard trim');
  await page.fill('#wa-form-title', 'Book a visit');
  await page.waitForFunction(() => /Book a visit/.test(document.getElementById('wa-form-preview').innerText) && /Haircut/.test(document.getElementById('wa-form-preview').innerText));

  await page.click('#wa-form-save');
  await page.waitForFunction(() => /Wasi Demo Booking/.test(document.getElementById('wa-forms-tbody').innerText));
  assert.match(await page.locator('#wa-forms-tbody').innerText(), /Draft/);
  const created = metaCalls.find((c) => /\/flows$/.test(c.url));
  const sent = JSON.parse(created.body);
  assert.deepEqual(sent.categories, ['APPOINTMENT_BOOKING']);
  const dropdown = JSON.parse(sent.flow_json).screens[0].layout.children.find((c) => c.name === 'service');
  assert.deepEqual(dropdown['data-source'].map((o) => o.title), ['Haircut', 'Beard trim']);

  await page.click('[data-wa-form-action="publish"]');
  await page.click('#modal-confirm-action-btn');
  await page.waitForFunction(() => /Published/.test(document.getElementById('wa-forms-tbody').innerText));
  assert.equal(await page.locator('[data-wa-form-action="duplicate"]').count(), 1, 'published forms offer Duplicate, not Edit');
  assert.equal(await page.locator('[data-wa-form-action="edit"]').count(), 0);
  await page.close();
});

test('Forms page: too-long wording shows the reasons in the drawer, nothing sent to Meta', async () => {
  const page = await openApp('whatsapp-flows');
  await page.click('#open-wa-form-drawer');
  await page.waitForSelector('#modal-wa-form.open');
  await page.fill('#wa-form-name', 'Too long');
  await page.evaluate(() => { document.getElementById('wa-form-title').removeAttribute('maxlength'); });
  await page.fill('#wa-form-title', 'This title is definitely longer than thirty characters');
  const before = metaCalls.length;
  await page.click('#wa-form-save');
  await page.waitForSelector('#wa-form-errors:not([hidden])');
  assert.match(await page.locator('#wa-form-errors').innerText(), /Form title must be 30 characters or fewer/);
  assert.equal(metaCalls.length, before);
  await page.close();
});

test('Chat: More actions > Send form sends the published form and shows it in the thread', async () => {
  const page = await openApp('chat');
  await page.waitForSelector(`[data-chat-id="${chatId}"], .chat-list-item`);
  await page.evaluate((id) => document.querySelector(`[data-chat-id="${id}"]`)?.click(), chatId);
  await page.waitForFunction(() => /Form Tester/.test(document.querySelector('#view-chat').innerText));
  await page.click('#chat-more-menu-btn');
  await page.click('#chat-send-form-btn');
  await page.waitForSelector('#modal-send-form.open');
  assert.match(await page.locator('#send-form-select').innerText(), /Wasi Demo Booking/);
  await page.click('#send-form-form button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById('modal-send-form').classList.contains('open'));
  const send = metaCalls.filter((c) => /\/messages$/.test(c.url)).at(-1);
  const p = JSON.parse(send.body).interactive.action.parameters;
  assert.equal(p.flow_cta, 'Open form');
  assert.equal(p.mode, undefined, 'published form, so no draft banner');
  await page.waitForFunction(() => /\[form: Wasi Demo Booking\]/.test(document.querySelector('#view-chat').innerText));
  await page.close();
});

test('Forms page fits a 375px phone', async () => {
  const page = await openApp('whatsapp-flows', 375);
  await page.waitForFunction(() => /Wasi Demo Booking/.test(document.getElementById('wa-forms-tbody').innerText));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.close();
});
