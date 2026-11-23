// Ad lead feedback to Meta (build-docs/features/ctwa-conversions.md).
// Meta faked via global.fetch; local test DB, disposable client.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { encrypt } = require('../src/utils/encryption');

const PREFIX = '__test_suite__ctwacv_';
const EMAIL = `test-suite-ctwacv-${Date.now()}@wasi.local`;
const WABA_ID = `${PREFIX}waba`;
let server, base, token, clientId, adChat, plainChat;
let metaCalls = [];
let metaFail = false;
const realFetch = global.fetch;

before(async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    metaCalls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (metaFail) return new Response(JSON.stringify({ error: { message: 'Requires Marketing API access' } }), { status: 400 });
    const body = u.endsWith('/dataset') ? { id: 'DS777' } : { events_received: 1 };
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
  await pool.query(`insert into wabas (client_id, waba_id, phone_number_id, status, access_token_encrypted) values ($1, $2, 'p', 'connected', $3)`, [clientId, WABA_ID, encrypt('fake-token')]);
  adChat = (await pool.query(`insert into chats (client_id, name, phone) values ($1, 'Ad Person', '919000000101') returning id`, [clientId])).rows[0].id;
  plainChat = (await pool.query(`insert into chats (client_id, name, phone) values ($1, 'No Clid', '919000000102') returning id`, [clientId])).rows[0].id;
  await pool.query(`insert into messages (chat_id, client_id, direction, body, sent_at, referral) values
    ($1, $3, 'in', 'hi', now() - interval '1 day', $4), ($2, $3, 'in', 'hi', now() - interval '1 day', $5)`,
  [adChat, plainChat, clientId, JSON.stringify({ source_id: 'ad1', headline: 'Sale', ctwa_clid: 'CLID-123' }), JSON.stringify({ source_id: 'ad1', headline: 'Sale' })]);
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

beforeEach(() => { metaCalls = []; metaFail = false; });
const api = (p, opts = {}) => realFetch(`${base}${p}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
const convert = (chat, body) => api(`/api/analytics/ctwa/chats/${chat}/conversion`, { method: 'POST', body: JSON.stringify(body) });

test('a chat without an ad click id cannot be reported, and nothing is sent', async () => {
  const res = await convert(plainChat, { event: 'LeadSubmitted' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /click id/);
  assert.equal(metaCalls.length, 0);
});

test('a Meta refusal is shown and nothing is recorded', async () => {
  metaFail = true;
  const res = await convert(adChat, { event: 'LeadSubmitted' });
  assert.equal(res.status, 502);
  assert.match((await res.json()).detail, /Marketing API/);
  assert.equal((await pool.query('select count(*)::int n from ctwa_conversions where chat_id = $1', [adChat])).rows[0].n, 0);
});

test('lead: creates the dataset once, sends the documented event, records it; a repeat is refused', async () => {
  assert.equal((await convert(adChat, { event: 'LeadSubmitted' })).status, 201);
  assert.equal(metaCalls[0].url.endsWith(`/${WABA_ID}/dataset`), true);
  assert.equal(metaCalls[1].url.endsWith('/DS777/events'), true);
  const ev = metaCalls[1].body.data[0];
  assert.equal(ev.event_name, 'LeadSubmitted');
  assert.equal(ev.action_source, 'business_messaging');
  assert.equal(ev.messaging_channel, 'whatsapp');
  assert.deepEqual(ev.user_data, { whatsapp_business_account_id: WABA_ID, ctwa_clid: 'CLID-123' });
  assert.equal(ev.custom_data, undefined);
  assert.equal((await pool.query('select ctwa_dataset_id from wabas where client_id = $1', [clientId])).rows[0].ctwa_dataset_id, 'DS777');

  metaCalls = [];
  const again = await convert(adChat, { event: 'LeadSubmitted' });
  assert.equal(again.status, 409);
  assert.equal(metaCalls.length, 0, 'Meta does not dedupe, so Wasi never sends twice');
});

test('sale: needs an amount; sends value + currency; reuses the stored dataset', async () => {
  assert.equal((await convert(adChat, { event: 'Purchase' })).status, 400);
  assert.equal((await convert(adChat, { event: 'Purchase', value: 1499 })).status, 201);
  assert.equal(metaCalls.length, 1, 'no second dataset call');
  assert.deepEqual(metaCalls[0].body.data[0].custom_data, { currency: 'INR', value: 1499 });
});

test('the ad chat list shows which chats can be reported and what was reported', async () => {
  const q = new URLSearchParams({ sourceId: 'ad1', headline: 'Sale' });
  const { chats } = await api(`/api/analytics/ctwa/chats?${q}`).then((r) => r.json());
  const ad = chats.find((c) => c.chatId === adChat);
  const plain = chats.find((c) => c.chatId === plainChat);
  assert.equal(ad.hasClickId, true);
  assert.deepEqual(ad.conversions.sort(), ['LeadSubmitted', 'Purchase']);
  assert.equal(plain.hasClickId, false);
  assert.deepEqual(plain.conversions, []);
});
