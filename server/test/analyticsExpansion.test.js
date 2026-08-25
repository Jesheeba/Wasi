// Analytics expansion (GAP_FIX_PLAN.md Phase E3): configurable ?days=
// window, CSV exports, and the two new trend aggregations (contact
// growth, campaign performance). Same dedicated-disposable-client pattern
// as the other test files.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;
let clientToken;
let testClientId;

const SUITE_PREFIX = '__test_suite__analyticsExpansion_';

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
      email: `test-suite-analytics-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  // A couple of contacts and a chat/message so the trend/export queries
  // below have at least one real row to return, not just an empty-array
  // happy path.
  await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Contact`, phone: '910000000003' }),
  });
  const chat = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}ChatContact`, phone: '910000000004' }),
  }).then((r) => r.json());
  await pool.query(
    `insert into messages (chat_id, client_id, direction, body, status, meta_message_id)
     values ($1, $2, 'in', 'hi', 'delivered', $3)`,
    [chat.id, testClientId, `${SUITE_PREFIX}msg`]
  );
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('GET /api/analytics/messages still defaults to a 7-day window with no ?days=', async () => {
  const res = await fetch(`${baseUrl}/api/analytics/messages`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.incoming >= 1, 'the seeded inbound message must be counted in the default window');
});

test('GET /api/analytics/messages respects a configurable ?days=', async () => {
  const res = await fetch(`${baseUrl}/api/analytics/messages?days=90`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.incoming >= 1);
});

test('GET /api/analytics/messages/trend returns a real per-day breakdown', async () => {
  const res = await fetch(`${baseUrl}/api/analytics/messages/trend?days=7`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.ok(Array.isArray(rows));
  assert.ok(rows.some((r) => r.incoming >= 1), 'the seeded inbound message must appear on its day');
});

test('GET /api/analytics/messages/export returns real CSV, not JSON', async () => {
  const res = await fetch(`${baseUrl}/api/analytics/messages/export?days=7`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const text = await res.text();
  assert.match(text, /^Date,Outgoing,Incoming,Sent,Delivered,Read,Failed/);
});

test('GET /api/analytics/tags/export returns real CSV', async () => {
  const res = await fetch(`${baseUrl}/api/analytics/tags/export`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const text = await res.text();
  assert.match(text, /^Tag,Contacts,Conversion Rate %/);
});

test('GET /api/analytics/contacts/growth backfills a cumulative count, not just daily deltas', async () => {
  const res = await fetch(`${baseUrl}/api/analytics/contacts/growth?days=30`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.startingCount, 'number');
  assert.ok(Array.isArray(body.trend));
  if (body.trend.length) {
    const last = body.trend[body.trend.length - 1];
    assert.ok(last.cumulativeContacts >= last.newContacts, 'cumulative must include the starting count, not reset to 0');
  }
});

test('GET /api/analytics/campaigns/trend responds even with zero campaigns', async () => {
  const res = await fetch(`${baseUrl}/api/analytics/campaigns/trend?days=30`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.deepEqual(rows, []);
});

test('unauthenticated request to any new endpoint is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/analytics/messages/trend`);
  assert.equal(res.status, 401);
});
