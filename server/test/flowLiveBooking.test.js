// Live booking forms (booking_live) + the WhatsApp Flows data endpoint
// (build-docs/features/whatsapp-flows.md, phase 2). Meta is faked via
// global.fetch; WhatsApp's encrypted endpoint calls are reproduced with the
// same scheme (flowLiveBooking.encryptRequestForTest). Local test DB.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.APP_URL = 'https://wasi.test';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { encrypt, decrypt } = require('../src/utils/encryption');
const live = require('../src/utils/flowLiveBooking');
const tpl = require('../src/utils/whatsappFlowTemplates');

const PREFIX = '__test_suite__live_';
const EMAIL = `test-suite-live-${Date.now()}@wasi.local`;
let server, base, token, clientId, chatId, flowId, publicKey;
let metaCalls = [];
const realFetch = global.fetch;

before(async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    metaCalls.push({ url: u, method: opts.method || 'GET', body: opts.body, headers: opts.headers });
    let body = { success: true };
    if (/\/flows$/.test(u)) body = { id: `meta_live_${metaCalls.length}`, validation_errors: [] };
    if (/\/messages$/.test(u)) body = { messages: [{ id: 'wamid.live' }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  const reg = await realFetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${PREFIX}client`, email: EMAIL, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  token = reg.token;
  clientId = reg.client.id;
  await pool.query(`insert into wabas (client_id, waba_id, phone_number_id, status, access_token_encrypted) values ($1, $2, 'ph_live', 'connected', $3)`,
    [clientId, `${PREFIX}waba`, encrypt('fake-token')]);
  chatId = (await pool.query(`insert into chats (client_id, name, phone) values ($1, 'Booker', '919092766740') returning id`, [clientId])).rows[0].id;
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

beforeEach(() => { metaCalls = []; });
const api = (p, opts = {}) => realFetch(`${base}${p}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

// First bookable date in the window that falls on an open weekday.
function openDate(config) {
  for (let i = 1; i <= config.daysAhead; i++) {
    const d = live.localDate(config, new Date(), i);
    if (live.slotsForDate(config, d).length) return d;
  }
  throw new Error('no open date');
}
function closedDate(config) {
  for (let i = 1; i <= config.daysAhead; i++) {
    const d = live.localDate(config, new Date(), i);
    if (!config.days.includes(new Date(`${d}T12:00:00Z`).getUTCDay())) return d;
  }
  return null;
}

async function callEndpoint(request, { sign = true, id = flowId, pub = publicKey } = {}) {
  const { body, aesKey, iv } = live.encryptRequestForTest(request, pub);
  const raw = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (sign) headers['x-hub-signature-256'] = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
  const res = await realFetch(`${base}/webhooks/flows/${id}`, { method: 'POST', headers, body: raw });
  return { status: res.status, reply: res.status === 200 ? live.decryptResponseForTest(await res.text(), aesKey, iv) : null };
}

// ---------- pure ----------

test('config limits, open days and capacity', () => {
  assert.deepEqual(live.normalizeConfig({}).errors, []);
  const bad = live.normalizeConfig({ days: [], start: '18:00', end: '10:00', slotMinutes: 7, capacity: 0, daysAhead: 400 }).errors;
  assert.equal(bad.length, 5);
  const { config } = live.normalizeConfig({ days: [1, 2, 3, 4, 5], start: '10:00', end: '11:30', slotMinutes: 30, capacity: 2 });
  const d = openDate(config);
  assert.deepEqual(live.slotsForDate(config, d), ['10:00', '10:30', '11:00']);
  assert.deepEqual(live.freeSlots(config, d, { '10:00': 2, '10:30': 1 }).map((s) => s.id), ['10:30', '11:00']);
  assert.deepEqual(live.slotsForDate(config, live.localDate(config, new Date(), 0)), [], 'today is never bookable');
  const closed = closedDate(config);
  if (closed) assert.deepEqual(live.slotsForDate(config, closed), []);
});

test('Flow JSON uses the endpoint: data_api_version, routing model, data_exchange footers', () => {
  const json = live.buildFlowJson(live.normalizeConfig({}).config);
  assert.equal(json.data_api_version, '3.0');
  assert.deepEqual(json.routing_model, { DATE: ['SLOTS'], SLOTS: [] });
  for (const s of json.screens) assert.equal(s.layout.children.at(-1)['on-click-action'].name, 'data_exchange');
  assert.equal(json.screens[1].layout.children.find((c) => c.type === 'Dropdown')['data-source'], '${data.slots}');
});

test('encryption round trip matches Meta\'s scheme (RSA-OAEP-256 key, AES-GCM, flipped IV)', () => {
  const kp = live.generateKeyPair();
  const { body, aesKey, iv } = live.encryptRequestForTest({ action: 'ping' }, kp.publicKey);
  const out = live.decryptRequest(body, kp.privateKey);
  assert.deepEqual(out.request, { action: 'ping' });
  const enc = live.encryptResponse({ data: { status: 'active' } }, out.aesKey, out.iv);
  assert.deepEqual(live.decryptResponseForTest(enc, aesKey, iv), { data: { status: 'active' } });
});

// ---------- creating a live form ----------

test('creating a live form uploads a key once, sets the endpoint, stores the private key encrypted', async () => {
  const res = await api('/api/whatsapp-flows', { method: 'POST', body: JSON.stringify({ name: 'Wasi Demo Live Booking', kind: 'booking_live', config: { days: [0, 1, 2, 3, 4, 5, 6], start: '10:00', end: '11:00', slotMinutes: 30, capacity: 1 } }) });
  assert.equal(res.status, 201);
  flowId = (await res.json()).id;
  const keyCall = metaCalls.find((c) => c.url.endsWith('/ph_live/whatsapp_business_encryption'));
  assert.equal(keyCall.headers['Content-Type'], 'application/x-www-form-urlencoded');
  publicKey = new URLSearchParams(keyCall.body).get('business_public_key');
  assert.match(publicKey, /BEGIN PUBLIC KEY/);
  const create = JSON.parse(metaCalls.find((c) => /\/flows$/.test(c.url)).body);
  assert.equal(create.endpoint_uri, `https://wasi.test/webhooks/flows/${flowId}`);
  assert.deepEqual(create.categories, ['APPOINTMENT_BOOKING']);
  const stored = (await pool.query('select flows_private_key_encrypted from wabas where client_id = $1', [clientId])).rows[0].flows_private_key_encrypted;
  assert.equal(stored.includes('PRIVATE KEY'), false, 'not stored in plain text');
  assert.match(decrypt(stored), /BEGIN PRIVATE KEY/);

  metaCalls = [];
  await api('/api/whatsapp-flows', { method: 'POST', body: JSON.stringify({ name: 'Second', kind: 'booking_live' }) });
  assert.equal(metaCalls.filter((c) => c.url.includes('whatsapp_business_encryption')).length, 0, 'key uploaded only once');
});

// ---------- the endpoint ----------

test('endpoint: unsigned 432, wrong key 421, ping, token for another form 427', async () => {
  assert.equal((await callEndpoint({ action: 'ping' }, { sign: false })).status, 432);
  assert.equal((await callEndpoint({ action: 'ping' }, { pub: live.generateKeyPair().publicKey })).status, 421);
  assert.deepEqual((await callEndpoint({ action: 'ping', version: '3.0' })).reply, { data: { status: 'active' } });
  assert.equal((await callEndpoint({ action: 'INIT', flow_token: `wasi_flow:${crypto.randomUUID()}` })).status, 427);
});

test('endpoint: INIT shows the date window; a date shows only free slots; booking fills capacity', async () => {
  const flowToken = tpl.makeFlowToken(flowId, chatId);
  const config = live.normalizeConfig({ days: [0, 1, 2, 3, 4, 5, 6], start: '10:00', end: '11:00', slotMinutes: 30, capacity: 1 }).config;
  const init = (await callEndpoint({ action: 'INIT', flow_token: flowToken })).reply;
  assert.equal(init.screen, 'DATE');
  assert.deepEqual(init.data, { min_date: live.dateRange(config).min, max_date: live.dateRange(config).max });

  const day = openDate(config);
  const slots = (await callEndpoint({ action: 'data_exchange', screen: 'DATE', data: { date: day }, flow_token: flowToken })).reply;
  assert.equal(slots.screen, 'SLOTS');
  assert.deepEqual(slots.data.slots, [{ id: '10:00', title: '10:00 AM' }, { id: '10:30', title: '10:30 AM' }]);

  const booked = (await callEndpoint({ action: 'data_exchange', screen: 'SLOTS', data: { date: day, slot: '10:00', name: 'Asha' }, flow_token: flowToken })).reply;
  assert.equal(booked.screen, 'SUCCESS');
  assert.deepEqual(booked.data.extension_message_response.params, { flow_token: flowToken, name: 'Asha', date: day, slot: '10:00' });
  const row = (await pool.query('select chat_id, name, slot_time from whatsapp_flow_bookings where flow_id = $1', [flowId])).rows[0];
  assert.deepEqual(row, { chat_id: chatId, name: 'Asha', slot_time: '10:00' });

  const again = (await callEndpoint({ action: 'data_exchange', screen: 'SLOTS', data: { date: day, slot: '10:00', name: 'Bala' }, flow_token: flowToken })).reply;
  assert.equal(again.screen, 'SLOTS', 'a taken slot is refused');
  assert.match(again.data.error_message, /just taken/);
  assert.deepEqual(again.data.slots.map((s) => s.id), ['10:30']);
});

test('endpoint: two people booking the last place at once - only one wins', async () => {
  const flowToken = tpl.makeFlowToken(flowId, chatId);
  const config = live.normalizeConfig({ days: [0, 1, 2, 3, 4, 5, 6], start: '10:00', end: '11:00', slotMinutes: 30, capacity: 1 }).config;
  const day = live.localDate(config, new Date(), 2);
  const results = await Promise.all(['A', 'B', 'C'].map((n) => callEndpoint({ action: 'data_exchange', screen: 'SLOTS', data: { date: day, slot: '10:30', name: n }, flow_token: flowToken })));
  assert.equal(results.filter((r) => r.reply.screen === 'SUCCESS').length, 1);
  assert.equal((await pool.query(`select count(*)::int n from whatsapp_flow_bookings where flow_id = $1 and slot_date = $2 and slot_time = '10:30'`, [flowId, day])).rows[0].n, 1);
});

test('endpoint: a slot outside opening hours or the window is refused', async () => {
  const flowToken = tpl.makeFlowToken(flowId, chatId);
  const config = live.normalizeConfig({ days: [0, 1, 2, 3, 4, 5, 6], start: '10:00', end: '11:00' }).config;
  const r = (await callEndpoint({ action: 'data_exchange', screen: 'SLOTS', data: { date: openDate(config), slot: '23:00', name: 'X' }, flow_token: flowToken })).reply;
  assert.notEqual(r.screen, 'SUCCESS');
  const past = (await callEndpoint({ action: 'data_exchange', screen: 'DATE', data: { date: '2020-01-01' }, flow_token: flowToken })).reply;
  assert.equal(past.screen, 'DATE');
  assert.match(past.data.error_message, /No free times/);
});

test('chat: a live form opens with data_exchange and carries the chat in its token', async () => {
  await pool.query(`insert into messages (chat_id, client_id, direction, body, sent_at) values ($1, $2, 'in', 'hi', now() - interval '1 minute')`, [chatId, clientId]);
  const res = await api(`/api/chats/${chatId}/forms`, { method: 'POST', body: JSON.stringify({ flowId, body: 'Book a slot', cta: 'Book now' }) });
  assert.equal(res.status, 201);
  const p = JSON.parse(metaCalls.find((c) => /\/messages$/.test(c.url)).body).interactive.action.parameters;
  assert.equal(p.flow_action, 'data_exchange');
  assert.equal(p.flow_action_payload, undefined);
  assert.equal(p.flow_token, `wasi_flow:${flowId}:${chatId}`);
  assert.equal(tpl.flowIdFromToken(p.flow_token), flowId);
  assert.equal(tpl.chatIdFromToken(p.flow_token), chatId);
});
