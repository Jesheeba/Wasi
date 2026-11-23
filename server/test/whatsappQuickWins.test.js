// WhatsApp quick wins (build-docs/features/whatsapp-quick-wins.md): read
// ticks + typing, block/unblock, QR codes, conversation starters, green tick,
// request_welcome. Meta is faked by stubbing global.fetch for
// graph.facebook.com; local test DB, disposable client deleted in after().
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { encrypt } = require('../src/utils/encryption');

const PREFIX = '__test_suite__qw_';
const EMAIL = `test-suite-qw-${Date.now()}@wasi.local`;
const WABA_ID = `${PREFIX}waba_${Date.now()}`;
const PHONE_ID = `${PREFIX}phone`;
let server, base, token, clientId, chatId, contactId, wabaRowId;
let metaCalls = [];
let metaReply = () => ({ status: 200, body: { success: true } });
const realFetch = global.fetch;

before(async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    const call = { url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null };
    metaCalls.push(call);
    const { status, body } = metaReply(call);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
  wabaRowId = (await pool.query(
    `insert into wabas (client_id, waba_id, phone_number_id, status, access_token_encrypted, registration_is_on_biz_app)
     values ($1, $2, $3, 'connected', $4, false) returning id`,
    [clientId, WABA_ID, PHONE_ID, encrypt('fake-token')]
  )).rows[0].id;
  contactId = (await pool.query(`insert into contacts (client_id, name, phone) values ($1, 'QW Contact', '919092766740') returning id`, [clientId])).rows[0].id;
  chatId = (await pool.query(`insert into chats (client_id, name, phone, contact_id) values ($1, 'QW Contact', '919092766740', $2) returning id`, [clientId, contactId])).rows[0].id;
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

beforeEach(() => { metaCalls = []; metaReply = () => ({ status: 200, body: { success: true } }); });
const api = (p, opts = {}) => realFetch(`${base}${p}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

// ---------- read ticks + typing ----------

test('read: nothing to mark before any inbound message, and no Meta call', async () => {
  const res = await api(`/api/chats/${chatId}/read`, { method: 'POST' });
  assert.deepEqual(await res.json(), { sent: false, reason: 'no_inbound_message' });
  assert.equal(metaCalls.length, 0);
});

test('read marks the newest inbound message; typing adds the indicator', async () => {
  await pool.query(`insert into messages (chat_id, client_id, direction, body, sent_at, meta_message_id) values
    ($1, $2, 'in', 'old', now() - interval '2 hours', 'wamid.old'), ($1, $2, 'in', 'new', now() - interval '1 minute', 'wamid.new')`, [chatId, clientId]);
  assert.deepEqual(await (await api(`/api/chats/${chatId}/read`, { method: 'POST' })).json(), { sent: true });
  assert.deepEqual(metaCalls[0].body, { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.new' });
  await api(`/api/chats/${chatId}/typing`, { method: 'POST' });
  assert.deepEqual(metaCalls[1].body.typing_indicator, { type: 'text' });
});

test('read is best effort: a Meta error still answers 200', async () => {
  metaReply = () => ({ status: 400, body: { error: { message: 'boom' } } });
  const res = await api(`/api/chats/${chatId}/read`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sent, false);
});

// ---------- block ----------

test('block: a 24h refusal (failed_users 131047) is explained and nothing is marked', async () => {
  metaReply = () => ({ status: 200, body: { block_users: { added_users: [], failed_users: [{ input: '+919092766740', errors: [{ code: 131047, message: 'Re-engagement required' }] }] } } });
  const res = await api(`/api/chats/${chatId}/block`, { method: 'POST' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /last 24 hours/);
  assert.equal((await api(`/api/chats/${chatId}/block`).then((r) => r.json())).blocked, false);
});

test('block then unblock calls Meta with +phone and tracks the state', async () => {
  metaReply = () => ({ status: 200, body: { block_users: { added_users: [{ input: '+919092766740', wa_id: '919092766740' }] } } });
  assert.equal((await api(`/api/chats/${chatId}/block`, { method: 'POST' })).status, 200);
  assert.equal(metaCalls[0].method, 'POST');
  assert.deepEqual(metaCalls[0].body.block_users, [{ user: '+919092766740' }]);
  assert.equal((await api(`/api/chats/${chatId}/block`).then((r) => r.json())).blocked, true);
  metaReply = () => ({ status: 200, body: { block_users: { removed_users: [{ input: '+919092766740' }] } } });
  assert.equal((await api(`/api/chats/${chatId}/block`, { method: 'DELETE' })).status, 200);
  assert.equal(metaCalls[1].method, 'DELETE');
  assert.equal((await api(`/api/chats/${chatId}/block`).then((r) => r.json())).blocked, false);
});

// ---------- QR codes ----------

test('QR codes: create stores the image URL, edit, delete; limits enforced', async () => {
  assert.equal((await api('/api/whatsapp-tools/qr-codes', { method: 'POST', body: JSON.stringify({ message: 'x'.repeat(141) }) })).status, 400);
  assert.equal(metaCalls.length, 0);
  metaReply = () => ({ status: 200, body: { code: 'ABC123', prefilled_message: 'Hi from poster', deep_link_url: 'https://wa.me/message/ABC123', qr_image_url: 'https://scontent.example/qr.png' } });
  const created = await api('/api/whatsapp-tools/qr-codes', { method: 'POST', body: JSON.stringify({ message: 'Hi from poster' }) }).then((r) => r.json());
  assert.equal(created.qr_image_url, 'https://scontent.example/qr.png');
  assert.deepEqual(metaCalls[0].body, { prefilled_message: 'Hi from poster', generate_qr_image: 'PNG' });
  const list = await api('/api/whatsapp-tools/qr-codes').then((r) => r.json());
  assert.equal(list.length, 1);

  metaReply = () => ({ status: 200, body: { code: 'ABC123', prefilled_message: 'New text' } });
  const edited = await api('/api/whatsapp-tools/qr-codes/ABC123', { method: 'PATCH', body: JSON.stringify({ message: 'New text' }) }).then((r) => r.json());
  assert.equal(edited.prefilled_message, 'New text');
  assert.deepEqual(metaCalls.at(-1).body, { code: 'ABC123', prefilled_message: 'New text' });

  metaReply = () => ({ status: 400, body: { error: { message: 'Code does not exist' } } });
  assert.equal((await api('/api/whatsapp-tools/qr-codes/ABC123', { method: 'DELETE' })).status, 204, 'already gone on Meta still removes ours');
  assert.equal((await api('/api/whatsapp-tools/qr-codes').then((r) => r.json())).length, 0);
});

// ---------- conversation starters ----------

test('starters: read from Meta, limits enforced, commands saved without the slash', async () => {
  metaReply = () => ({ status: 200, body: { conversational_automation: { enable_welcome_message: true, prompts: ['Fees?'], commands: [{ command_name: 'hours', command_description: 'Opening hours' }] } } });
  const got = await api('/api/whatsapp-tools/conversational-automation').then((r) => r.json());
  assert.deepEqual(got, { enableWelcomeMessage: true, prompts: ['Fees?'], commands: [{ name: 'hours', description: 'Opening hours' }] });

  const put = (body) => api('/api/whatsapp-tools/conversational-automation', { method: 'PUT', body: JSON.stringify(body) });
  metaCalls = [];
  assert.equal((await put({ enableWelcomeMessage: false, prompts: ['a', 'b', 'c', 'd', 'e'], commands: [] })).status, 400);
  assert.equal((await put({ enableWelcomeMessage: false, prompts: ['Hi 👋'], commands: [] })).status, 400);
  assert.equal((await put({ enableWelcomeMessage: false, prompts: [], commands: [{ name: '/a', description: 'x' }, { name: 'A', description: 'y' }] })).status, 400, 'duplicate names');
  assert.equal(metaCalls.length, 0, 'nothing invalid reached Meta');
  metaReply = () => ({ status: 200, body: { success: true } });
  assert.equal((await put({ enableWelcomeMessage: true, prompts: ['What are your fees?'], commands: [{ name: '/hours', description: 'Opening hours' }] })).status, 200);
  assert.deepEqual(metaCalls[0].body, { enable_welcome_message: true, prompts: ['What are your fees?'], commands: [{ command_name: 'hours', command_description: 'Opening hours' }] });
});

// ---------- green tick ----------

test('green tick: status shown; application validated and mapped to Meta fields', async () => {
  metaReply = () => ({ status: 200, body: { official_business_account: { oba_status: 'NOT_STARTED' } } });
  assert.deepEqual(await api('/api/whatsapp-tools/green-tick').then((r) => r.json()), { eligible: true, status: 'NOT_STARTED' });
  const links = ['https://a.in', 'https://b.in', 'https://c.in', 'https://d.in', 'https://e.in'];
  metaCalls = [];
  assert.equal((await api('/api/whatsapp-tools/green-tick', { method: 'POST', body: JSON.stringify({ websiteUrl: 'https://biz.in', country: 'India', supportingLinks: links.slice(0, 4) }) })).status, 400);
  assert.equal(metaCalls.length, 0);
  metaReply = () => ({ status: 200, body: { success: true, updated_status: { oba_status: 'PENDING' } } });
  const ok = await api('/api/whatsapp-tools/green-tick', { method: 'POST', body: JSON.stringify({ websiteUrl: 'https://biz.in', country: 'India', supportingLinks: links }) }).then((r) => r.json());
  assert.equal(ok.status, 'PENDING');
  assert.deepEqual(metaCalls[0].body, { business_website_url: 'https://biz.in', primary_country_of_operation: 'India', supporting_links: links });
});

test('green tick: numbers on the WhatsApp Business app are told why, and cannot apply', async () => {
  await pool.query('update wabas set registration_is_on_biz_app = true where id = $1', [wabaRowId]);
  assert.deepEqual(await api('/api/whatsapp-tools/green-tick').then((r) => r.json()), { eligible: false, reason: 'business_app', status: null });
  const res = await api('/api/whatsapp-tools/green-tick', { method: 'POST', body: JSON.stringify({ websiteUrl: 'https://biz.in', country: 'India', supportingLinks: ['https://a.in', 'https://b.in', 'https://c.in', 'https://d.in', 'https://e.in'] }) });
  assert.equal(res.status, 409);
  assert.equal(metaCalls.length, 0);
  await pool.query('update wabas set registration_is_on_biz_app = false where id = $1', [wabaRowId]);
});

// ---------- request_welcome + roles ----------

test('request_welcome is stored as "Opened the chat"', async () => {
  const wamid = `wamid.${PREFIX}welcome_${Date.now()}`;
  const payload = { object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID },
    contacts: [{ wa_id: '919000011111', profile: { name: 'New Person' } }],
    messages: [{ from: '919000011111', id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'request_welcome' }],
  } }] }] };
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
  assert.equal((await realFetch(`${base}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body })).status, 200);
  assert.equal((await pool.query('select body from messages where meta_message_id = $1', [wamid])).rows[0].body, 'Opened the chat');
});

test('roles: block and account tools are Admin/Manager only', () => {
  const chats = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'chats.js'), 'utf8');
  assert.match(chats, /router\.post\('\/:id\/block', requireRole\('Admin', 'Manager'\)/);
  assert.match(chats, /router\.delete\('\/:id\/block', requireRole\('Admin', 'Manager'\)/);
  const tools = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'whatsappTools.js'), 'utf8');
  assert.match(tools, /router\.use\(requireRole\('Admin', 'Manager'\)\);/);
});
