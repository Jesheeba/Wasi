// Hub API v1's unified error-response shape ({ error: { code, message } },
// wasi-master-plan.md §8.6) and rate-limit visibility headers
// (middleware/rateLimit.js's apiLimiter). Same dedicated-disposable-test-
// client pattern as apiV1.test.js/apiV1Reads.test.js — see those files'
// before()/after() comments for why a throwaway client (never the demo
// one) is used and deleted after.
//
// Every individual error branch this file checks (404s, the auth failures,
// the client_id mismatch, an unmatched /api/v1/* path) was already covered
// for status code by apiV1.test.js/apiV1Reads.test.js before this change —
// this file adds the one thing those didn't check: that the *shape* wrapping
// each of those statuses is now consistently { error: { code, message } }
// rather than the five different ad-hoc shapes routes/apiV1*.js used to
// hand-roll (see the commit that introduced utils/apiError.js).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const contactsRepo = require('../src/repositories/contactsRepo');
const chatsRepo = require('../src/repositories/chatsRepo');

let server;
let baseUrl;
let testClientId;
let adminToken;
let apiKey;

const SUITE_PREFIX = '__test_suite__apiv1errshape_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
function apiAuthed(key) {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

// Asserts the response body is exactly the new shape: an `error` object with
// a non-empty string `code` and a non-empty string `message`, and nothing
// else at the top level (catches an accidental sibling field slipping back
// in outside `error`, the same "audit the whole shape, not just one field"
// discipline the forward_secret/key_hash leak fixes established).
async function assertApiErrorShape(res, expectedStatus, expectedCode) {
  assert.equal(res.status, expectedStatus);
  const data = await res.json();
  assert.deepEqual(Object.keys(data), ['error'], 'response body must have exactly one top-level key: error');
  assert.equal(typeof data.error.code, 'string');
  assert.ok(data.error.code.length > 0);
  assert.equal(typeof data.error.message, 'string');
  assert.ok(data.error.message.length > 0);
  if (expectedCode) assert.equal(data.error.code, expectedCode);
  return data.error;
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
      email: `test-suite-apiv1errshape-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  testClientId = registered.client?.id;
  assert.ok(testClientId, 'dedicated test client registration must succeed');

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

test('missing bearer token: 401, { error: { code: missing_bearer_token, message } }', async () => {
  const res = await fetch(`${baseUrl}/api/v1/templates`);
  await assertApiErrorShape(res, 401, 'missing_bearer_token');
});

test('garbage/invalid API key: 401, { error: { code: invalid_api_key, message } }', async () => {
  const res = await fetch(`${baseUrl}/api/v1/templates`, { headers: apiAuthed('not-a-real-key') });
  await assertApiErrorShape(res, 401, 'invalid_api_key');
});

test('GET /api/v1/messages/:id/status for an unknown id: 404, code message_not_found', async () => {
  const res = await fetch(`${baseUrl}/api/v1/messages/00000000-0000-0000-0000-000000000099/status`, {
    headers: apiAuthed(apiKey),
  });
  await assertApiErrorShape(res, 404, 'message_not_found');
});

test('GET /api/v1/templates/:id for an unknown id: 404, code template_not_found', async () => {
  const res = await fetch(`${baseUrl}/api/v1/templates/00000000-0000-0000-0000-000000000099`, {
    headers: apiAuthed(apiKey),
  });
  await assertApiErrorShape(res, 404, 'template_not_found');
});

test('GET /api/v1/conversations/:id/messages for an unknown/foreign chat id: 404, code conversation_not_found', async () => {
  const res = await fetch(`${baseUrl}/api/v1/conversations/00000000-0000-0000-0000-000000000099/messages`, {
    headers: apiAuthed(apiKey),
  });
  await assertApiErrorShape(res, 404, 'conversation_not_found');
});

test('POST /api/v1/messages with a client_id that does not match the key: 403, code client_id_mismatch', async () => {
  const contact = await contactsRepo.upsertByPhone(pool, testClientId, {
    phone: `91970${Date.now()}`.slice(0, 12), name: 'Mismatch Contact',
  });
  const res = await fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: apiAuthed(apiKey),
    body: JSON.stringify({
      client_id: '00000000-0000-0000-0000-000000000099', to: contact.phone, type: 'text', body: 'hi',
    }),
  });
  await assertApiErrorShape(res, 403, 'client_id_mismatch');
});

test('POST /api/v1/templates with an invalid body: 400, code invalid_template_body, details is a non-empty array nested under error', async () => {
  const res = await fetch(`${baseUrl}/api/v1/templates`, {
    method: 'POST',
    headers: apiAuthed(apiKey),
    body: JSON.stringify({ name: `${SUITE_PREFIX}bad_${Date.now()}`, category: 'Utility', body: 'Hello {{1}}, thanks!' }),
  });
  const err = await assertApiErrorShape(res, 400, 'invalid_template_body');
  assert.ok(Array.isArray(err.details) && err.details.length > 0);
});

test('a Zod query-validation failure (out-of-range limit) still normalizes to { error: { code: validation_failed, message, details } }', async () => {
  const res = await fetch(`${baseUrl}/api/v1/conversations?limit=500`, { headers: apiAuthed(apiKey) });
  const err = await assertApiErrorShape(res, 400, 'validation_failed');
  assert.ok(Array.isArray(err.details) && err.details.length > 0);
});

test('an unmatched /api/v1/* path: 404, same shape as a real route\'s not-found (not the app-wide plain {error} 404)', async () => {
  const res = await fetch(`${baseUrl}/api/v1/this-route-does-not-exist`, { headers: apiAuthed(apiKey) });
  await assertApiErrorShape(res, 404, 'not_found');
});

test('a route outside /api/v1 keeps the pre-existing plain {error: "string"} shape, unaffected by this change', async () => {
  const res = await fetch(`${baseUrl}/api/this-route-does-not-exist`);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(typeof data.error, 'string');
});

test('every /api/v1/* response carries live X-RateLimit-* headers, including on an error response', async () => {
  const ok = await fetch(`${baseUrl}/api/v1/templates`, { headers: apiAuthed(apiKey) });
  assert.equal(ok.status, 200);
  assert.ok(Number(ok.headers.get('x-ratelimit-limit')) === 300);
  assert.ok(Number(ok.headers.get('x-ratelimit-remaining')) >= 0);
  assert.ok(Number(ok.headers.get('x-ratelimit-remaining')) < 300);
  assert.ok(Number(ok.headers.get('x-ratelimit-reset')) > Math.floor(Date.now() / 1000));

  const remainingBefore = Number(ok.headers.get('x-ratelimit-remaining'));
  const unauthorized = await fetch(`${baseUrl}/api/v1/templates`, { headers: apiAuthed('not-a-real-key') });
  assert.equal(unauthorized.status, 401);
  const remainingAfter = Number(unauthorized.headers.get('x-ratelimit-remaining'));
  assert.ok(remainingAfter <= remainingBefore, 'the limiter runs before auth, so even a rejected request consumes the bucket and the header reflects it');
});

test('GET /api/v1/account/rate-limit\'s static body is honest about being IP-scoped, not per-key', async () => {
  const res = await fetch(`${baseUrl}/api/v1/account/rate-limit`, { headers: apiAuthed(apiKey) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.match(data.scope, /source IP/i);
  assert.doesNotMatch(data.scope, /^per API key/i);
});

test('GET /api/v1/conversations/:id/messages for a real chat still 200s with the unchanged success shape (regression guard)', async () => {
  const contact = await contactsRepo.upsertByPhone(pool, testClientId, {
    phone: `91980${Date.now()}`.slice(0, 12), name: 'Shape Regression Contact',
  });
  const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
  const res = await fetch(`${baseUrl}/api/v1/conversations/${chat.id}/messages`, { headers: apiAuthed(apiKey) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
});

// Deliberately last: exhausts this file's own 300/min apiLimiter budget
// (shared across every /api/v1/* mount, see rateLimit.js), so every test
// above that expects a normal (non-429) response must run before this one.
test('exceeding the 300/min ceiling returns a real 429 in the same { error: { code: rate_limited, message } } shape', async () => {
  // apiLimiter's in-memory store is created fresh per createApp() call
  // (rateLimit.js is required once per test-runner process, and node --test
  // runs each file in its own process) — this file's own earlier requests
  // already count against the 300 budget, so top up to comfortably past it
  // rather than assuming a full fresh bucket. Sent in modest concurrent
  // batches, not all 320+ at once — firing them all simultaneously
  // overwhelms the local test server's own connection backlog (ECONNREFUSED)
  // well before the rate limiter itself ever gets a chance to reject one.
  const results = [];
  for (let i = 0; i < 340 && !results.some((res) => res.status === 429); i += 20) {
    const batch = await Promise.all(
      Array.from({ length: 20 }, () => fetch(`${baseUrl}/api/v1/templates`, { headers: apiAuthed(apiKey) }))
    );
    results.push(...batch);
  }
  const limited = results.find((res) => res.status === 429);
  assert.ok(limited, 'at least one batched request should have been rate-limited');
  await assertApiErrorShape(limited, 429, 'rate_limited');
});
