// GET /api/templates/verify-url - a cheap pre-flight check for a button/
// LTO/carousel-card URL, so a malformed or dead link is caught in seconds
// on blur, not after the full Meta submission round trip. Own dedicated
// disposable test client. The live reachability check (global.fetch) is
// stubbed - this app's own convention for any network-touching test - but
// the SSRF guard itself (assertPublicHttpsUrl) is NOT stubbed, since that's
// exactly the real logic under test for the blocked-address cases.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server, baseUrl, clientToken, testClientId;

const SUITE_PREFIX = '__test_suite__verifyurl_';

function authed(token) {
  return { Authorization: `Bearer ${token}` };
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
      email: `test-suite-verifyurl-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('GET /api/templates/verify-url: a malformed URL is rejected locally, never reaches fetch', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('localhost')) return originalFetch(url, options); // this app's own API calls
    throw new Error('must not fetch an invalid URL');
  };
  try {
    const res = await fetch(`${baseUrl}/api/templates/verify-url?url=${encodeURIComponent('not-a-url')}`, { headers: authed(clientToken) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reachable, false);
    assert.ok(body.error);
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/templates/verify-url: a non-https URL is rejected locally', async () => {
  const res = await fetch(`${baseUrl}/api/templates/verify-url?url=${encodeURIComponent('http://example.com')}`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reachable, false);
  assert.match(body.error, /https/);
});

test('GET /api/templates/verify-url: a private/link-local IP literal is rejected locally (SSRF guard), never reaches fetch', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes(`localhost:${new URL(baseUrl).port}`)) return originalFetch(url, options);
    throw new Error('must not fetch a private-address URL');
  };
  try {
    // An IP literal, not a hostname - resolves locally, no real DNS query
    // (same convention mediaHeaderService.test.js's own assertPublicHttpsUrl
    // tests already use for this exact reason). The cloud instance-
    // metadata address, same one isBlockedAddress's own unit test covers.
    const res = await fetch(`${baseUrl}/api/templates/verify-url?url=${encodeURIComponent('https://169.254.169.254/latest/meta-data/')}`, { headers: authed(clientToken) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reachable, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/templates/verify-url: a reachable public URL reports reachable: true', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('localhost')) return originalFetch(url, options);
    if (String(url).includes('example.com') && options?.method === 'HEAD') {
      return { ok: true, status: 200 };
    }
    throw new Error(`unexpected fetch: ${url} ${options?.method}`);
  };
  try {
    const res = await fetch(`${baseUrl}/api/templates/verify-url?url=${encodeURIComponent('https://example.com/shop')}`, { headers: authed(clientToken) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reachable, true);
    assert.equal(body.status, 200);
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/templates/verify-url: HEAD rejected (405) falls back to GET before reporting unreachable', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    if (String(url).includes('localhost')) return originalFetch(url, options);
    calls.push(options?.method);
    if (String(url).includes('example.com') && options?.method === 'HEAD') {
      return { ok: false, status: 405, statusText: 'Method Not Allowed' };
    }
    if (String(url).includes('example.com') && options?.method === 'GET') {
      return { ok: true, status: 200 };
    }
    throw new Error(`unexpected fetch: ${url} ${options?.method}`);
  };
  try {
    const res = await fetch(`${baseUrl}/api/templates/verify-url?url=${encodeURIComponent('https://example.com/shop')}`, { headers: authed(clientToken) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reachable, true);
    assert.deepEqual(calls, ['HEAD', 'GET']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/templates/verify-url: a real network failure (timeout/DNS) reports reachable: false with a reason, never 500s', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('localhost')) return originalFetch(url, options);
    const err = new Error('getaddrinfo ENOTFOUND does-not-exist.example');
    throw err;
  };
  try {
    const res = await fetch(`${baseUrl}/api/templates/verify-url?url=${encodeURIComponent('https://does-not-exist.example/')}`, { headers: authed(clientToken) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reachable, false);
    assert.ok(body.error);
  } finally {
    global.fetch = originalFetch;
  }
});
