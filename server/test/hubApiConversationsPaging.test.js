// Hub API: conversations paging/polling + optional client_id on sends
// (build-docs/features/hub-api-conversations-paging.md).
// Disposable client, no WABA: a send that passes validation stops at a send
// guard, never at Meta.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const contactsRepo = require('../src/repositories/contactsRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const { ADMIN_PASSWORD } = require('./helpers/adminCredentials');

let server, BASE, clientId, apiKey;
const PREFIX = '__test_suite__convpaging_';
const BASE_TIME = Date.parse('2026-11-01T00:00:00Z');
const chatIds = []; // newest first after setup

const get = (qs) => fetch(`${BASE}/api/v1/conversations${qs}`, { headers: { Authorization: `Bearer ${apiKey}` } })
  .then(async (r) => ({ status: r.status, data: await r.json() }));
const send = (body) => fetch(`${BASE}/api/v1/messages`, {
  method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://localhost:${server.address().port}`;

  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${PREFIX}client`, email: `test-suite-convpaging-${Date.now()}@wasi.local`, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  clientId = reg.client?.id;
  assert.ok(clientId, 'test client registration must succeed');

  const admin = await fetch(`${BASE}/api/admin/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: ADMIN_PASSWORD }),
  }).then((r) => r.json());
  const key = await fetch(`${BASE}/api/admin/api-keys`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, app_name: `${PREFIX}app` }),
  }).then((r) => r.json());
  apiKey = key.key;
  assert.ok(apiKey, 'api key creation must succeed');

  // 5 chats, one hour apart; chat i has last_message_at = BASE_TIME + i hours.
  for (let i = 0; i < 5; i++) {
    const contact = await contactsRepo.upsertByPhone(pool, clientId, { phone: `9198700000${i}` });
    const chat = await chatsRepo.findOrCreateByContact(pool, clientId, contact);
    await pool.query('update chats set last_message_at = $2 where id = $1', [chat.id, new Date(BASE_TIME + i * 3600e3)]);
    chatIds.unshift(chat.id);
  }
});

after(async () => {
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('AC1: offset pages through every conversation once, newest first', async () => {
  const seen = [];
  for (let offset = 0; offset <= 10; offset += 2) { // bounded: an ignored offset must fail, not loop
    const { status, data } = await get(`?limit=2&offset=${offset}`);
    assert.equal(status, 200);
    seen.push(...data.map((c) => c.id));
    if (data.length < 2) break;
  }
  assert.deepEqual(seen, chatIds);
});

test('AC2: updated_after (and its alias since) returns only conversations active after that time', async () => {
  const after2h = new Date(BASE_TIME + 2 * 3600e3).toISOString();
  const { status, data } = await get(`?updated_after=${encodeURIComponent(after2h)}`);
  assert.equal(status, 200);
  assert.deepEqual(data.map((c) => c.id), chatIds.slice(0, 2)); // hours 4 and 3
  const alias = await get(`?since=${encodeURIComponent(after2h)}`);
  assert.deepEqual(alias.data.map((c) => c.id), chatIds.slice(0, 2));
});

test('AC3: unsupported or malformed parameters are a 400, not silently ignored', async () => {
  for (const qs of ['?page=2', '?after=x', '?updated_after=not-a-date', '?offset=-1']) {
    const { status, data } = await get(qs);
    assert.equal(status, 400, qs);
    assert.equal(data.error.code, 'validation_failed', qs);
  }
});

test('AC4: POST /messages works without client_id; a wrong one is still refused', async () => {
  const msg = { to: '919870000099', type: 'text', body: 'hi' };
  // Passing validation means it gets as far as the send guards (no inbound
  // yet, no WABA), never validation_failed or client_id_mismatch.
  const without = await send(msg);
  assert.ok(!['validation_failed', 'client_id_mismatch'].includes(without.data.error.code), without.data.error.code);
  const matching = await send({ ...msg, client_id: clientId });
  assert.equal(matching.data.error.code, without.data.error.code);
  const wrong = await send({ ...msg, client_id: '00000000-0000-0000-0000-000000000001' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.data.error.code, 'client_id_mismatch');
});
