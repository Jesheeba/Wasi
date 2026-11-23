// Forms phase 3 (build-docs/features/whatsapp-flows.md): answers to contact
// fields, a template to send anytime, CSV download, live bookings list and
// cancel. Meta faked via global.fetch; local test DB, disposable client.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.APP_URL = 'https://wasi.test';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { encrypt } = require('../src/utils/encryption');

const PREFIX = '__test_suite__f3_';
const EMAIL = `test-suite-f3-${Date.now()}@wasi.local`;
const WABA_ID = `${PREFIX}waba_${Date.now()}`;
const PHONE_ID = `${PREFIX}phone`;
let server, base, token, clientId, chatId, contactId, flowId, liveId, attrText, attrNumber;
let metaCalls = [];
const realFetch = global.fetch;

before(async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    const body = typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body;
    metaCalls.push({ url: u, method: opts.method || 'GET', body });
    let reply = { success: true };
    if (/\/flows$/.test(u)) reply = { id: `meta_f3_${metaCalls.length}`, validation_errors: [] };
    if (/\/message_templates$/.test(u)) reply = { id: 'tpl_meta_1', status: 'PENDING', category: 'MARKETING' };
    if (/\/messages$/.test(u)) reply = { messages: [{ id: `wamid.f3${metaCalls.length}` }] };
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  await pool.query(`insert into wabas (client_id, waba_id, phone_number_id, status, access_token_encrypted) values ($1, $2, $3, 'connected', $4)`,
    [clientId, WABA_ID, PHONE_ID, encrypt('fake-token')]);
  contactId = (await pool.query(`insert into contacts (client_id, name, phone) values ($1, 'Form Person', '919092766740') returning id`, [clientId])).rows[0].id;
  chatId = (await pool.query(`insert into chats (client_id, name, phone, contact_id) values ($1, 'Form Person', '919092766740', $2) returning id`, [clientId, contactId])).rows[0].id;
  attrText = (await pool.query(`insert into contact_attributes (client_id, name, type) values ($1, 'Course', 'text') returning id`, [clientId])).rows[0].id;
  attrNumber = (await pool.query(`insert into contact_attributes (client_id, name, type) values ($1, 'Budget', 'number') returning id`, [clientId])).rows[0].id;
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

beforeEach(() => { metaCalls = []; });
const api = (p, opts = {}) => realFetch(`${base}${p}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

test('setup: a lead form and a live booking form', async () => {
  flowId = (await api('/api/whatsapp-flows', { method: 'POST', body: JSON.stringify({ name: 'Wasi Demo Lead', kind: 'lead', config: { fields: { interest: { options: ['NEET', 'JEE'] } } } }) }).then((r) => r.json())).id;
  liveId = (await api('/api/whatsapp-flows', { method: 'POST', body: JSON.stringify({ name: 'Wasi Demo Live', kind: 'booking_live', config: { days: [0, 1, 2, 3, 4, 5, 6] } }) }).then((r) => r.json())).id;
  assert.ok(flowId && liveId);
});

test('contact fields: validated, saved, and answers copied onto the contact (type mismatches skipped)', async () => {
  const put = (map) => api(`/api/whatsapp-flows/${flowId}/attribute-map`, { method: 'PUT', body: JSON.stringify({ map }) });
  assert.equal((await put({ nonsense: attrText })).status, 400);
  assert.equal((await put({ interest: crypto.randomUUID() })).status, 400, 'attribute must belong to the client');
  const saved = await put({ interest: attrText, notes: attrNumber, name: null }).then((r) => r.json());
  assert.deepEqual(saved.attribute_map, { interest: attrText, notes: attrNumber });

  const wamid = `wamid.${PREFIX}reply_${Date.now()}`;
  const payload = { object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID },
    contacts: [{ wa_id: '919092766740', profile: { name: 'Form Person' } }],
    messages: [{ from: '919092766740', id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive',
      interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: JSON.stringify({ flow_token: `wasi_flow:${flowId}`, name: 'Asha', interest: 'opt_2', notes: 'call me evenings' }) } } }],
  } }] }] };
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
  assert.equal((await realFetch(`${base}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body: raw })).status, 200);
  const vals = (await pool.query('select attribute_id, value from contact_attribute_values where contact_id = $1', [contactId])).rows;
  assert.deepEqual(vals, [{ attribute_id: attrText, value: 'JEE' }], 'dropdown saved as its text; text into a number field skipped');
});

test('CSV: one row per response, labelled columns, choices as text', async () => {
  const res = await api(`/api/whatsapp-flows/${flowId}/responses.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /Wasi_Demo_Lead_responses\.csv/);
  const [header, row] = (await res.text()).split('\r\n');
  assert.equal(header, 'Submitted,Contact,Phone,Full name,Email,Interested in,Anything else?');
  assert.match(row, /,Form Person,919092766740,Asha,,JEE,call me evenings$/);
});

test('template: created on Meta with a FLOW button; live forms open with data_exchange; only once', async () => {
  const mk = (id, body) => api(`/api/whatsapp-flows/${id}/template`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await mk(flowId, { category: 'MARKETING', body: 'Fill this in', buttonText: 'Open 📋' })).status, 400);
  const res = await mk(flowId, { category: 'MARKETING', body: 'Please fill in this short form', buttonText: 'Open form' });
  assert.equal(res.status, 201);
  const sent = metaCalls.find((c) => c.url.endsWith('/message_templates')).body;
  assert.equal(sent.category, 'MARKETING');
  const btn = sent.components.find((c) => c.type === 'BUTTONS').buttons[0];
  assert.deepEqual({ type: btn.type, flow_action: btn.flow_action, navigate_screen: btn.navigate_screen }, { type: 'FLOW', flow_action: 'navigate', navigate_screen: 'LEAD_FORM' });
  const tpl = (await pool.query('select status, category from message_templates where client_id = $1 and name like $2', [clientId, 'wasi_demo_lead_form_%'])).rows[0];
  assert.deepEqual(tpl, { status: 'pending', category: 'MARKETING' });
  assert.equal((await mk(flowId, { category: 'MARKETING', body: 'x', buttonText: 'y' })).status, 409);

  metaCalls = [];
  await mk(liveId, { category: 'UTILITY', body: 'Book your slot', buttonText: 'Book now' });
  const liveBtn = metaCalls.find((c) => c.url.endsWith('/message_templates')).body.components[1].buttons[0];
  assert.equal(liveBtn.flow_action, 'data_exchange');
  assert.equal(liveBtn.navigate_screen, undefined);
});

test('send outside 24h: needs an approved template, then goes out as that template with our token', async () => {
  const send = () => api(`/api/chats/${chatId}/forms`, { method: 'POST', body: JSON.stringify({ flowId, body: 'Form', cta: 'Open form' }) });
  await pool.query("update messages set sent_at = now() - interval '2 days' where chat_id = $1", [chatId]);
  const pending = await send();
  assert.equal(pending.status, 409);
  assert.equal((await pending.json()).code, 'template_not_approved');
  assert.equal(metaCalls.length, 0);

  await pool.query(`update message_templates set status = 'approved' where client_id = $1 and name like 'wasi_demo_lead_form_%'`, [clientId]);
  assert.equal((await send()).status, 201);
  const msg = metaCalls.find((c) => /\/messages$/.test(c.url)).body;
  assert.equal(msg.type, 'template');
  assert.match(msg.template.name, /^wasi_demo_lead_form_/);
  assert.deepEqual(msg.template.components, [{ type: 'button', sub_type: 'flow', index: '0', parameters: [{ type: 'action', action: { flow_token: `wasi_flow:${flowId}` } }] }]);
});

test('live bookings: listed, cancelled once, and the cancelled slot no longer counts', async () => {
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const id = (await pool.query(`insert into whatsapp_flow_bookings (client_id, flow_id, chat_id, slot_date, slot_time, name) values ($1, $2, $3, $4, '10:00', 'Ravi') returning id`, [clientId, liveId, chatId, day])).rows[0].id;
  const list = await api(`/api/whatsapp-flows/${liveId}/bookings`).then((r) => r.json());
  assert.deepEqual(list.map((b) => [b.date, b.time, b.name, b.status]), [[day, '10:00', 'Ravi', 'booked']]);
  assert.equal((await api(`/api/whatsapp-flows/${liveId}/bookings/${id}/cancel`, { method: 'POST' })).status, 200);
  assert.equal((await api(`/api/whatsapp-flows/${liveId}/bookings/${id}/cancel`, { method: 'POST' })).status, 404);
  const counted = (await pool.query(`select count(*)::int n from whatsapp_flow_bookings where flow_id = $1 and slot_date = $2 and slot_time = '10:00' and status = 'booked'`, [liveId, day])).rows[0].n;
  assert.equal(counted, 0);
});
