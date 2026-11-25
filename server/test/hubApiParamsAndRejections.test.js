// Hub API parameter check + refused-request log
// (build-docs/features/hub-api-template-param-check.md,
//  build-docs/features/hub-api-rejection-log.md).
// Disposable client, no WABA: a send that passes every check stops at
// waba_not_connected, never at Meta.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const apiKeysRepo = require('../src/repositories/apiKeysRepo');
const apiRejectionsRepo = require('../src/repositories/apiRejectionsRepo');
const { checkSendParams } = require('../src/utils/templateParams');
const { ADMIN_PASSWORD } = require('./helpers/adminCredentials');

let server, BASE, clientId, clientToken, apiKey, apiKeyId;
const PREFIX = '__test_suite__params_';
const TO = '919800000101';

const api = (path, body, key = apiKey) => fetch(`${BASE}${path}`, {
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));

async function approvedTemplate(body, bodyParamExamples) {
  const name = `${PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const t = await fetch(`${BASE}/api/templates`, {
    method: 'POST', headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, category: 'Utility', body, bodyParamExamples }),
  }).then((r) => r.json());
  assert.ok(t.id, `template created: ${JSON.stringify(t)}`);
  await pool.query("update message_templates set status = 'approved' where id = $1", [t.id]);
  return name;
}

const send = (template, params) => api('/api/v1/messages', { client_id: clientId, to: TO, type: 'template', template, ...(params !== undefined ? { params } : {}) });

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://localhost:${server.address().port}`;
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${PREFIX}client`, email: `test-params-${Date.now()}@wasi.local`, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  clientId = reg.client.id;
  clientToken = reg.token;
  const key = await apiKeysRepo.create(pool, clientId, `${PREFIX}n8n`);
  apiKey = key.rawKey;
  apiKeyId = key.record.id;
});

after(async () => {
  if (clientId) {
    await pool.query("delete from audit_log where actor_type = 'client' and actor_id = $1", [clientId]);
    await pool.query('delete from clients where id = $1', [clientId]);
  }
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('checkSendParams: exact match passes; none expected, missing, extra and empty are explained', () => {
  assert.equal(checkSendParams('t', 'Hello {{hi}}, welcome', { hi: 'Priya' }), null);
  assert.equal(checkSendParams('t', 'No variables here', {}), null);
  assert.equal(checkSendParams('t', 'No variables here', undefined), null);
  assert.match(checkSendParams('t', 'No variables here', { hi: 'x' }), /has no parameters - remove "params"/);
  assert.match(checkSendParams('t', 'Hi {{name}} {{amount}}', { name: 'a' }), /Missing: "amount"/);
  assert.match(checkSendParams('t', 'Hi {{name}}', { name: 'a', hi: 'b' }), /Not in this template: "hi"/);
  assert.match(checkSendParams('t', 'Hi {{name}}', { name: '  ' }), /must not be empty/);
  assert.equal(checkSendParams('t', 'Hi {{1}} and {{2}}', { 1: 'a', 2: 'b' }), null, 'positional templates match by number');
});

test('AC1: params sent to a template with no variables -> 400 params_mismatch, nothing sent', async () => {
  const name = await approvedTemplate('Thank you for registering for the conclave, we look forward to seeing you there.');
  const r = await send(name, { hi: 'Priya' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, 'params_mismatch');
  assert.match(r.data.error.message, /has no parameters/);
  const { rows } = await pool.query(
    `select count(*)::int n from messages m join chats c on c.id = m.chat_id where c.client_id = $1 and m.api_key_id = $2`, [clientId, apiKeyId]
  );
  assert.equal(rows[0].n, 0, 'no message row');
  // Without params it passes the check (stops later: no WABA).
  assert.equal((await send(name)).data.error.code, 'waba_not_connected');
});

test('AC2: missing, extra or empty params for a template with variables -> params_mismatch; correct params pass', async () => {
  const name = await approvedTemplate('Hello {{hi}}, thank you so much for registering with us today, see you soon!', { hi: 'Priya' });
  assert.equal((await send(name, {})).data.error.code, 'params_mismatch');
  assert.equal((await send(name, { name: 'Priya' })).data.error.code, 'params_mismatch');
  assert.equal((await send(name, { hi: '' })).data.error.code, 'params_mismatch');
  assert.equal((await send(name, { hi: 'Priya' })).data.error.code, 'waba_not_connected');
});

test('AC3: every refusal of an API-key request is logged with code, key and path; a bad key is not', async () => {
  await pool.query('delete from api_rejections where client_id = $1', [clientId]);
  await api('/api/v1/messages', { client_id: clientId, to: 'undefined', type: 'text', body: 'hi' });
  await api('/api/v1/messages', { client_id: clientId, to: TO, type: 'text', body: 'hi' }, 'wasi_not_a_real_key');
  await new Promise((r) => setTimeout(r, 100)); // the log write is not awaited by the response

  const { rows } = await pool.query('select * from api_rejections where client_id = $1 order by id', [clientId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 'invalid_phone');
  assert.equal(rows[0].status, 400);
  assert.equal(rows[0].api_key_id, apiKeyId);
  assert.equal(rows[0].method, 'POST');
  assert.equal(rows[0].path, '/api/v1/messages');
  assert.match(rows[0].message, /Received "undefined"/);
});

test('AC4: admin Client Detail returns the refused requests', async () => {
  const login = await fetch(`${BASE}/api/admin/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: ADMIN_PASSWORD }),
  }).then((r) => r.json());
  assert.ok(login.token, 'admin login');
  const detail = await fetch(`${BASE}/api/admin/clients/${clientId}`, { headers: { Authorization: `Bearer ${login.token}` } }).then((r) => r.json());
  assert.ok(Array.isArray(detail.hubApiRejections));
  const row = detail.hubApiRejections.find((r) => r.code === 'invalid_phone');
  assert.ok(row);
  assert.equal(row.app_name, `${PREFIX}n8n`);
});

test('AC5: rows older than 30 days are purged, newer ones kept', async () => {
  await pool.query(
    `insert into api_rejections (client_id, api_key_id, method, path, status, code, created_at)
     values ($1, $2, 'POST', '/api/v1/messages', 400, 'old_one', now() - interval '31 days')`, [clientId, apiKeyId]
  );
  await apiRejectionsRepo.purgeOld();
  const { rows } = await pool.query('select code from api_rejections where client_id = $1', [clientId]);
  assert.ok(!rows.some((r) => r.code === 'old_one'));
  assert.ok(rows.some((r) => r.code === 'invalid_phone'));
});
