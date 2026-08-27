// Hub API v1 read endpoints added for the Wasi MCP server (wasi-mcp-server-plan.md):
// GET /api/v1/messages/:id/status, GET /api/v1/templates/:id,
// GET /api/v1/conversations[/:id/messages], GET /api/v1/contacts,
// GET /api/v1/account[/rate-limit]. Same dedicated-disposable-test-client
// pattern as apiV1.test.js — see that file's before()/after() comments for
// why a throwaway client (never the demo one) is used and deleted after.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const chatsRepo = require('../src/repositories/chatsRepo');

let server;
let baseUrl;
let clientToken;
let testClientId;
let adminToken;
let apiKey;

const SUITE_PREFIX = '__test_suite__apiv1reads_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
function apiAuthed(key) {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client`,
      email: `test-suite-apiv1reads-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: 'admin12345' }),
  }).then((r) => r.json());
  adminToken = adminLogin.token;
  assert.ok(adminToken, 'demo admin login must succeed — run `npm run db:seed` first');

  const created = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST',
    headers: authed(adminToken),
    body: JSON.stringify({ client_id: testClientId, app_name: `${SUITE_PREFIX}app` }),
  }).then((r) => r.json());
  apiKey = created.key;
  assert.ok(apiKey, 'api key creation via the admin route must succeed');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('get_account_status: no WABA connected yet -> connected:false, no secrets leaked', async () => {
  const res = await fetch(`${baseUrl}/api/v1/account`, { headers: apiAuthed(apiKey) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.connected, false);
  assert.equal(data.client_id, testClientId);
  assert.equal('access_token_encrypted' in data, false);
});

test('get_account_status: reflects a connected WABA\'s status and quality rating', async () => {
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: `${SUITE_PREFIX}waba`,
    phone_number_id: `${SUITE_PREFIX}phone`,
    status: 'connected',
    display_name: 'Test Business',
    quality_rating: 'GREEN',
  });
  try {
    const res = await fetch(`${baseUrl}/api/v1/account`, { headers: apiAuthed(apiKey) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.connected, true);
    assert.equal(data.status, 'connected');
    assert.equal(data.quality_rating, 'GREEN');
    assert.equal(data.display_name, 'Test Business');
  } finally {
    await wabasRepo.upsertForClient(testClientId, { status: 'disconnected' });
  }
});

test('get_rate_limit_status: returns the static account-wide ceiling', async () => {
  const res = await fetch(`${baseUrl}/api/v1/account/rate-limit`, { headers: apiAuthed(apiKey) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.limit_per_minute, 300);
  assert.equal(data.window_seconds, 60);
});

test('list_conversations: returns this client\'s chats only, respects limit', async () => {
  for (let i = 0; i < 3; i++) {
    const contact = await contactsRepo.upsertByPhone(pool, testClientId, {
      phone: `9192${i}${Date.now()}`.slice(0, 12),
      name: `Conv Contact ${i}`,
    });
    await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
  }
  const res = await fetch(`${baseUrl}/api/v1/conversations?limit=2`, { headers: apiAuthed(apiKey) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.length, 2);
  assert.ok(data.every((c) => c.client_id === testClientId));
});

test('list_conversations: limit is capped at 100 by schema, rejects out-of-range', async () => {
  const res = await fetch(`${baseUrl}/api/v1/conversations?limit=500`, { headers: apiAuthed(apiKey) });
  assert.equal(res.status, 400);
});

test('get_conversation_history: returns messages for one chat, 404s for an unknown/foreign chat id', async () => {
  const phone = `91930${Date.now()}`.slice(0, 12);
  const contact = await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: 'History Contact' });
  const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
  await chatsRepo.insertInbound(pool, testClientId, chat.id, {
    metaMessageId: `wamid.reads_history_${Date.now()}`, body: 'hello', sentAt: new Date().toISOString(),
  });

  const res = await fetch(`${baseUrl}/api/v1/conversations/${chat.id}/messages`, { headers: apiAuthed(apiKey) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.some((m) => m.body === 'hello'));

  const notFound = await fetch(`${baseUrl}/api/v1/conversations/00000000-0000-0000-0000-000000000099/messages`, {
    headers: apiAuthed(apiKey),
  });
  assert.equal(notFound.status, 404);
});

test('get_message_status: looks up a sent message by id without needing its chat_id', async () => {
  const contact = await contactsRepo.upsertByPhone(pool, testClientId, {
    phone: `91940${Date.now()}`.slice(0, 12), name: 'Status Contact',
  });
  const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
  const message = await chatsRepo.insertOutboundPending(pool, testClientId, chat.id, 'pending body');
  await chatsRepo.markSent(pool, testClientId, message.id, 'wamid.reads_status_test');

  const res = await fetch(`${baseUrl}/api/v1/messages/${message.id}/status`, { headers: apiAuthed(apiKey) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'sent');
  assert.equal(data.meta_message_id, 'wamid.reads_status_test');
});

test('get_message_status: 404 for a message id that doesn\'t belong to this client', async () => {
  const res = await fetch(`${baseUrl}/api/v1/messages/00000000-0000-0000-0000-000000000099/status`, {
    headers: apiAuthed(apiKey),
  });
  assert.equal(res.status, 404);
});

test('search_contacts: exact phone match', async () => {
  const phone = `91950${Date.now()}`.slice(0, 12);
  await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: 'Findable Person' });

  const res = await fetch(`${baseUrl}/api/v1/contacts?phone=${phone}`, { headers: apiAuthed(apiKey) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.length, 1);
  assert.equal(data[0].phone, phone);
});

test('search_contacts: name substring match, case-insensitive', async () => {
  await contactsRepo.upsertByPhone(pool, testClientId, {
    phone: `91960${Date.now()}`.slice(0, 12), name: 'Zebra Unique Marker',
  });
  const res = await fetch(`${baseUrl}/api/v1/contacts?q=zebra%20unique`, { headers: apiAuthed(apiKey) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.some((c) => c.name === 'Zebra Unique Marker'));
});

test('get_template_details: returns the full stored shape for one template, 404s otherwise', async () => {
  const created = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({
      name: `${SUITE_PREFIX}tpl_${Date.now()}`,
      category: 'Utility',
      body: 'Hi {{customer_name}}, your order shipped!',
      bodyParamExamples: { customer_name: 'Asha' },
    }),
  }).then((r) => r.json());

  const res = await fetch(`${baseUrl}/api/v1/templates/${created.id}`, { headers: apiAuthed(apiKey) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.name, created.name);
  assert.equal(data.body, 'Hi {{customer_name}}, your order shipped!');

  const notFound = await fetch(`${baseUrl}/api/v1/templates/00000000-0000-0000-0000-000000000099`, {
    headers: apiAuthed(apiKey),
  });
  assert.equal(notFound.status, 404);
});

test('every new v1 read route rejects a missing/invalid API key', async () => {
  const routes = [
    '/api/v1/account',
    '/api/v1/account/rate-limit',
    '/api/v1/conversations',
    '/api/v1/contacts',
  ];
  for (const route of routes) {
    const res = await fetch(`${baseUrl}${route}`, { headers: apiAuthed('not-a-real-key') });
    assert.equal(res.status, 401, `${route} should 401 on a bad key`);
  }
});
