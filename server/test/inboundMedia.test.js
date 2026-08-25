// Inbound media proxy route (GAP_FIX_PLAN.md Phase E1,
// server/src/routes/chats.js's GET /:id/messages/:messageId/media).
// Covers only the paths reachable without a real Meta call — same
// dedicated-disposable-client convention as api.test.js (a fresh client
// has no WABA, so nothing here can reach a real Meta API). The actual
// Meta-fetch success path needs a real WABA + a real media id and isn't
// covered by an automated test in this repo for that reason — see
// mediaHeaderService.test.js for the same tradeoff on the outbound side.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;
let clientToken;
let testClientId;
let chatId;
let textMessageId;

const SUITE_PREFIX = '__test_suite__inboundMedia_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
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
      email: `test-suite-inboundmedia-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  const chat = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Contact`, phone: '910000000001' }),
  }).then((r) => r.json());
  chatId = chat.id;
  assert.ok(chatId, 'test chat creation must succeed');

  // A text (non-media) message, inserted directly since this suite's
  // client has no WABA to actually send through — only need a message row
  // with media_id = null to prove the "no media attached" path.
  const { rows } = await pool.query(
    `insert into messages (chat_id, client_id, direction, body, status, meta_message_id)
     values ($1, $2, 'in', 'a plain text message', 'delivered', $3) returning id`,
    [chatId, testClientId, `${SUITE_PREFIX}text_msg`]
  );
  textMessageId = rows[0].id;
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('unauthenticated request is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/chats/${chatId}/messages/${textMessageId}/media`);
  assert.equal(res.status, 401);
});

test('unknown message id returns 404', async () => {
  const res = await fetch(
    `${baseUrl}/api/chats/${chatId}/messages/00000000-0000-0000-0000-000000000099/media`,
    { headers: authed(clientToken) }
  );
  assert.equal(res.status, 404);
});

test('a message with no media attached returns 404, not a Meta call', async () => {
  const res = await fetch(`${baseUrl}/api/chats/${chatId}/messages/${textMessageId}/media`, {
    headers: authed(clientToken),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /no media/i);
});

test('a media message on a client with no connected WABA fails cleanly (409), not a crash', async () => {
  const { rows } = await pool.query(
    `insert into messages (chat_id, client_id, direction, body, status, meta_message_id, media_id, media_mime_type)
     values ($1, $2, 'in', '[Image]', 'delivered', $3, 'fake_meta_media_id_123', 'image/jpeg') returning id`,
    [chatId, testClientId, `${SUITE_PREFIX}media_msg`]
  );
  const mediaMessageId = rows[0].id;

  const res = await fetch(`${baseUrl}/api/chats/${chatId}/messages/${mediaMessageId}/media`, {
    headers: authed(clientToken),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'waba_not_connected');
});
