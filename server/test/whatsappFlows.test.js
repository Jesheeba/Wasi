// WhatsApp Flows ("Forms") - build-docs/features/whatsapp-flows.md.
// Meta is faked: global.fetch is stubbed for graph.facebook.com only (the
// repo's convention), so nothing reaches WhatsApp. Runs against the local
// test database with a disposable __test_suite__ client, deleted in after().
//
// AC1 create from a type -> real meta_flow_id; edit drafts only; publish.
// AC2 send inside the 24h window (draft mode for drafts), refused outside it.
// AC3 a completed form (nfm_reply) becomes a readable chat message + a
//     stored response, once, even if Meta redelivers.
// AC4 existing send/retry paths unaffected; a failed form is never retried
//     as plain text.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { encrypt } = require('../src/utils/encryption');
const tpl = require('../src/utils/whatsappFlowTemplates');

const PREFIX = '__test_suite__waflows_';
const EMAIL = `test-suite-waflows-${Date.now()}@wasi.local`;
const WABA_ID = `${PREFIX}waba_${Date.now()}`;
const PHONE_ID = `${PREFIX}phone`;
let server, base, token, clientId, chatId;
let metaCalls = [];
let metaResponder = () => ({ status: 200, body: {} });
const realFetch = global.fetch;

before(async () => {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    const call = { url: u, method: opts.method || 'GET', body: opts.body };
    metaCalls.push(call);
    const { status, body } = metaResponder(call);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${PREFIX}client`, email: EMAIL, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  token = reg.token;
  clientId = reg.client.id;
  await pool.query(
    `insert into wabas (client_id, waba_id, phone_number_id, status, access_token_encrypted) values ($1, $2, $3, 'connected', $4)`,
    [clientId, WABA_ID, PHONE_ID, encrypt('fake-token')]
  );
  const chat = await pool.query(`insert into chats (client_id, name, phone) values ($1, 'Test Contact', '919092766740') returning id`, [clientId]);
  chatId = chat.rows[0].id;
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

beforeEach(() => { metaCalls = []; metaResponder = () => ({ status: 200, body: {} }); });

const api = (p, opts = {}) => fetch(`${base}${p}`, {
  ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const openWindow = () => pool.query(
  `insert into messages (chat_id, client_id, direction, body, sent_at) values ($1, $2, 'in', 'hi', now() - interval '1 hour')`,
  [chatId, clientId]
);

// ---------- pure builder ----------

test('builder: defaults produce valid-shaped Flow JSON 7.3 with a complete footer', () => {
  const { config, errors } = tpl.normalizeConfig('lead', {});
  assert.deepEqual(errors, []);
  const json = tpl.buildFlowJson('lead', config);
  assert.equal(json.version, '7.3');
  const screen = json.screens[0];
  assert.equal(screen.terminal, true);
  const footer = screen.layout.children.at(-1);
  assert.equal(footer.type, 'Footer');
  assert.equal(footer['on-click-action'].name, 'complete');
  assert.deepEqual(Object.keys(footer['on-click-action'].payload), ['name', 'email', 'interest', 'notes']);
  assert.equal(footer['on-click-action'].payload.name, '${form.name}');
  const dropdown = screen.layout.children.find((c) => c.type === 'Dropdown');
  assert.deepEqual(dropdown['data-source'][0], { id: 'opt_1', title: 'Product A' });
});

test('builder: Meta length limits and bad options are rejected with readable messages', () => {
  const { errors } = tpl.normalizeConfig('booking', {
    title: 'x'.repeat(31),
    fields: { name: { label: 'This label is far too long' }, service: { options: ['A', 'a'] }, slot: { options: [] } },
  });
  assert.ok(errors.some((e) => /Form title/.test(e)));
  assert.ok(errors.some((e) => /too long/.test(e)));
  assert.ok(errors.some((e) => /duplicate/.test(e)));
  assert.ok(errors.some((e) => /at least one option/.test(e)));
  assert.equal(tpl.normalizeConfig('quiz').errors.length, 1, 'unknown type');
});

test('builder: token round-trips; dropdown answers map back to their text', () => {
  const id = crypto.randomUUID();
  assert.equal(tpl.flowIdFromToken(tpl.makeFlowToken(id)), id);
  assert.equal(tpl.flowIdFromToken('unused'), null);
  const { config } = tpl.normalizeConfig('lead', {});
  const rows = tpl.describeResponse({ config }, { flow_token: 'x', name: 'Asha', interest: 'opt_2', notes: '' });
  assert.deepEqual(rows, [{ key: 'name', label: 'Full name', value: 'Asha' }, { key: 'interest', label: 'Interested in', value: 'Product B' }]);
});

// ---------- lifecycle ----------

let draftId;
test('AC1: create sends the form to Meta as a draft and stores its id', async () => {
  metaResponder = () => ({ status: 200, body: { id: 'meta_flow_1', success: true, validation_errors: [] } });
  const res = await api('/api/whatsapp-flows', { method: 'POST', body: JSON.stringify({ name: 'Wasi Demo Lead', kind: 'lead', config: { fields: { interest: { options: ['NEET', 'JEE'] } } } }) });
  assert.equal(res.status, 201);
  const flow = await res.json();
  draftId = flow.id;
  assert.equal(flow.meta_flow_id, 'meta_flow_1');
  assert.equal(flow.status, 'draft');
  assert.equal(metaCalls.length, 1);
  assert.match(metaCalls[0].url, new RegExp(`/${WABA_ID}/flows$`));
  const sent = JSON.parse(metaCalls[0].body);
  assert.deepEqual(sent.categories, ['LEAD_GENERATION']);
  assert.equal(JSON.parse(sent.flow_json).version, '7.3');
});

test('AC1: invalid wording is rejected before any Meta call', async () => {
  const res = await api('/api/whatsapp-flows', { method: 'POST', body: JSON.stringify({ name: 'Bad', kind: 'survey', config: { title: 'x'.repeat(40) } }) });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).details.length);
  assert.equal(metaCalls.length, 0);
});

test('AC1: Meta validation errors are stored and block publishing', async () => {
  metaResponder = () => ({ status: 200, body: { id: 'meta_flow_bad', success: true, validation_errors: [{ message: 'Invalid value found for property type.' }] } });
  const flow = await api('/api/whatsapp-flows', { method: 'POST', body: JSON.stringify({ name: 'Wasi Demo Invalid', kind: 'survey' }) }).then((r) => r.json());
  assert.match(flow.last_error, /Invalid value/);
  metaCalls = [];
  const pub = await api(`/api/whatsapp-flows/${flow.id}/publish`, { method: 'POST' });
  assert.equal(pub.status, 409);
  assert.equal(metaCalls.length, 0);
});

test('AC1: editing a draft re-uploads flow.json to Meta', async () => {
  metaResponder = () => ({ status: 200, body: { success: true, validation_errors: [] } });
  const res = await api(`/api/whatsapp-flows/${draftId}`, { method: 'PUT', body: JSON.stringify({ config: { title: 'Admissions' } }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).config.title, 'Admissions');
  assert.equal(metaCalls.length, 1);
  assert.match(metaCalls[0].url, /\/meta_flow_1\/assets$/);
  assert.ok(metaCalls[0].body instanceof FormData);
  assert.equal(metaCalls[0].body.get('asset_type'), 'FLOW_JSON');
  assert.equal(metaCalls[0].body.get('name'), 'flow.json');
});

// ---------- sending ----------

test('AC2: send is refused outside the 24h window, with no Meta call', async () => {
  const res = await api(`/api/chats/${chatId}/forms`, { method: 'POST', body: JSON.stringify({ flowId: draftId, body: 'Please fill this', cta: 'Open form' }) });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'session_window_closed');
  assert.equal(metaCalls.length, 0);
});

test('AC2: a draft form is sent in draft mode with our token; counts as a human reply', async () => {
  await openWindow();
  metaResponder = () => ({ status: 200, body: { messages: [{ id: 'wamid.form1' }] } });
  const res = await api(`/api/chats/${chatId}/forms`, { method: 'POST', body: JSON.stringify({ flowId: draftId, body: 'Please fill this', cta: 'Open form' }) });
  assert.equal(res.status, 201);
  const sent = JSON.parse(metaCalls[0].body);
  assert.equal(sent.interactive.type, 'flow');
  const p = sent.interactive.action.parameters;
  assert.equal(p.flow_message_version, '3');
  assert.equal(p.flow_id, 'meta_flow_1');
  assert.equal(p.flow_token, `wasi_flow:${draftId}`);
  assert.equal(p.mode, 'draft');
  assert.deepEqual(p.flow_action_payload, { screen: 'LEAD_FORM' });
  const row = (await pool.query('select body from messages where chat_id = $1 order by sent_at desc limit 1', [chatId])).rows[0];
  assert.match(row.body, /^\[form: Wasi Demo Lead\] Please fill this/);
  const chat = (await pool.query('select last_agent_reply_at from chats where id = $1', [chatId])).rows[0];
  assert.ok(chat.last_agent_reply_at, 'a person sending a form is human activity');
});

test('AC2: emoji in the button text is rejected', async () => {
  const res = await api(`/api/chats/${chatId}/forms`, { method: 'POST', body: JSON.stringify({ flowId: draftId, body: 'x', cta: 'Open 📋' }) });
  assert.equal(res.status, 400);
});

test('AC4: a failed form send is never retried as plain text', async () => {
  metaResponder = () => ({ status: 400, body: { error: { message: 'Flow not found', code: 100 } } });
  const res = await api(`/api/chats/${chatId}/forms`, { method: 'POST', body: JSON.stringify({ flowId: draftId, body: 'Retry me', cta: 'Open form' }) });
  assert.equal(res.status, 502);
  const failed = (await pool.query(`select id from messages where chat_id = $1 and status = 'failed' order by sent_at desc limit 1`, [chatId])).rows[0];
  metaCalls = [];
  const retry = await api(`/api/chats/${chatId}/messages/${failed.id}/retry`, { method: 'POST' });
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).code, 'cannot_retry_form');
  assert.equal(metaCalls.length, 0, 'nothing was sent');
});

// ---------- publish / duplicate / retire / delete ----------

test('AC1: publish, then edits are refused and duplicate makes a new draft', async () => {
  metaResponder = () => ({ status: 200, body: { success: true } });
  const pub = await api(`/api/whatsapp-flows/${draftId}/publish`, { method: 'POST' });
  assert.equal(pub.status, 200);
  assert.equal((await pub.json()).status, 'published');
  assert.match(metaCalls[0].url, /\/meta_flow_1\/publish$/);

  const edit = await api(`/api/whatsapp-flows/${draftId}`, { method: 'PUT', body: JSON.stringify({ config: {} }) });
  assert.equal(edit.status, 409);

  metaResponder = () => ({ status: 200, body: { id: 'meta_flow_copy', validation_errors: [] } });
  const dup = await api(`/api/whatsapp-flows/${draftId}/duplicate`, { method: 'POST' });
  assert.equal(dup.status, 201);
  const copy = await dup.json();
  assert.equal(copy.status, 'draft');
  assert.equal(copy.name, 'Wasi Demo Lead (copy)');
  assert.equal(copy.config.title, 'Admissions', 'wording carried over');

  // Published forms send without draft mode.
  metaResponder = () => ({ status: 200, body: { messages: [{ id: 'wamid.form2' }] } });
  metaCalls = [];
  await api(`/api/chats/${chatId}/forms`, { method: 'POST', body: JSON.stringify({ flowId: draftId, body: 'Live', cta: 'Open form' }) });
  assert.equal(JSON.parse(metaCalls[0].body).interactive.action.parameters.mode, undefined);
});

test('AC1: a published form must be retired before delete; retired deletes locally only', async () => {
  const del1 = await api(`/api/whatsapp-flows/${draftId}`, { method: 'DELETE' });
  assert.equal(del1.status, 409);
  metaResponder = () => ({ status: 200, body: { success: true } });
  metaCalls = [];
  const ret = await api(`/api/whatsapp-flows/${draftId}/deprecate`, { method: 'POST' });
  assert.equal((await ret.json()).status, 'deprecated');
  assert.match(metaCalls[0].url, /\/meta_flow_1\/deprecate$/);
  metaCalls = [];
  const del2 = await api(`/api/whatsapp-flows/${draftId}`, { method: 'DELETE' });
  assert.equal(del2.status, 204);
  assert.equal((await pool.query('select count(*)::int n from whatsapp_flows where id = $1', [draftId])).rows[0].n, 0, 'committed');
  assert.equal(metaCalls.length, 0, 'Meta cannot delete a retired flow, so it is not asked to');
});

test('AC1: deleting a draft deletes it on Meta first', async () => {
  const list = await api('/api/whatsapp-flows').then((r) => r.json());
  const copy = list.find((x) => x.meta_flow_id === 'meta_flow_copy');
  metaResponder = () => ({ status: 200, body: { success: true } });
  const res = await api(`/api/whatsapp-flows/${copy.id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(metaCalls[0].method, 'DELETE');
  assert.match(metaCalls[0].url, /\/meta_flow_copy$/);
  const left = (await pool.query('select count(*)::int n from whatsapp_flows where id = $1', [copy.id])).rows[0].n;
  assert.equal(left, 0, 'the delete is committed, not rolled back');
});

// ---------- receiving ----------

async function postWebhook(message) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '910000000000', phone_number_id: PHONE_ID },
      contacts: [{ wa_id: '919092766740', profile: { name: 'Test Contact' } }],
      messages: [message],
    } }] }],
  };
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
  return fetch(`${base}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body });
}

test('AC3: a completed form becomes a readable message and a stored response, once', async () => {
  metaResponder = () => ({ status: 200, body: { id: 'meta_flow_rx', validation_errors: [] } });
  const flow = await api('/api/whatsapp-flows', { method: 'POST', body: JSON.stringify({ name: 'Wasi Demo Rx', kind: 'lead' }) }).then((r) => r.json());
  const wamid = `wamid.${PREFIX}nfm_${Date.now()}`;
  const message = {
    from: '919092766740', id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive',
    interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: JSON.stringify({ flow_token: `wasi_flow:${flow.id}`, name: 'Asha', email: '', interest: 'opt_2', notes: 'Call after 6' }) } },
  };
  assert.equal((await postWebhook(message)).status, 200);
  assert.equal((await postWebhook(message)).status, 200, 'redelivery');

  const msg = (await pool.query('select body from messages where meta_message_id = $1', [wamid])).rows;
  assert.equal(msg.length, 1);
  assert.equal(msg[0].body, 'Form submitted: Wasi Demo Rx\nFull name: Asha\nInterested in: Product B\nAnything else?: Call after 6');

  const responses = await api(`/api/whatsapp-flows/${flow.id}/responses`).then((r) => r.json());
  assert.equal(responses.length, 1, 'stored once despite redelivery');
  assert.deepEqual(responses[0].answers.map((a) => a.value), ['Asha', 'Product B', 'Call after 6']);
  const list = await api('/api/whatsapp-flows').then((r) => r.json());
  assert.equal(list.find((x) => x.id === flow.id).response_count, 1);
});

test('AC3: a reply for an unknown or malformed form is still stored as a message', async () => {
  const wamid = `wamid.${PREFIX}nfm_bad_${Date.now()}`;
  const res = await postWebhook({
    from: '919092766740', id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive',
    interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{not json' } },
  });
  assert.equal(res.status, 200);
  const msg = (await pool.query('select body from messages where meta_message_id = $1', [wamid])).rows[0];
  assert.equal(msg.body, 'Form submitted');
  const stored = (await pool.query('select flow_id from whatsapp_flow_responses where meta_message_id = $1', [wamid])).rows[0];
  assert.equal(stored.flow_id, null);
});

test('AC4: management routes are Admin/Manager only; the human-reply rule still has one caller file', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'whatsappFlows.js'), 'utf8');
  for (const r of ["router.post('/', manage", "router.put('/:id', manage", "router.post('/:id/publish', manage", "router.post('/:id/deprecate', manage", "router.delete('/:id', manage", "router.post('/:id/duplicate', manage"]) {
    assert.ok(src.includes(r), r);
  }
  assert.equal(src.includes('markAgentReplyNonFatal'), false);
});
