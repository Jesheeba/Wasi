// Real-time messaging-tier detection (broadcast preflight warning feature,
// 2026-09-16). Covers: metaClient.messagingTierCap()'s pure mapping,
// messagingTierRefreshRunner.refreshOne persisting a real (or defensively
// 'unknown') tier, the admin manual-refresh route, metaWebhook.js's
// handleAccountUpdate picking up messaging_limit_tier when Meta sends it,
// and routes/broadcasts.js's tier-status/preflight-warning logic. Only
// graph.facebook.com is faked (this codebase's established convention) —
// everything else runs against the real (shared dev/prod) database via a
// dedicated disposable test client + WABA, deleted in after().
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const metaClient = require('../src/utils/metaClient');
const messagingTierRefreshRunner = require('../src/services/messagingTierRefreshRunner');
const { encrypt } = require('../src/utils/encryption');

let server;
let baseUrl;
let clientToken;
let testClientId;
let adminToken;

const SUITE_PREFIX = '__test_suite__messagingtier_';
const TEST_WABA_ID = 'test_suite_messagingtier_waba_id';
const TEST_PHONE_NUMBER_ID = 'test_suite_messagingtier_phone_id';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// `response` is either a plain phone-number-details object (success) or
// `{ fail: true }` to simulate a Meta-side failure (e.g. an expired token).
// Always forwards the full (url, options) pair to the real fetch for
// anything not graph.facebook.com — dropping `options` here previously broke
// the OUTER test's own call to this app's local test server (method/headers
// silently stripped), a real bug this comment exists to flag for anyone
// touching this helper again.
async function withFakeGraphFetch(response, fn) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    if (!urlStr.includes('graph.facebook.com')) return originalFetch(url, options);
    if (urlStr.includes(TEST_PHONE_NUMBER_ID)) {
      if (response.fail) return { ok: false, status: 401, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) };
      return { ok: true, json: async () => response };
    }
    return originalFetch(url, options);
  };
  try {
    await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

async function setWabaRow(fields) {
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: TEST_WABA_ID, phone_number_id: TEST_PHONE_NUMBER_ID, status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
    ...fields,
  });
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
      email: `test-suite-messagingtier-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  testClientId = registered.client?.id;
  clientToken = registered.token;
  assert.ok(testClientId && clientToken, 'dedicated test client registration must succeed');

  await setWabaRow({});

  const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: 'admin12345' }),
  }).then((r) => r.json());
  adminToken = adminLogin.token;
  assert.ok(adminToken, 'demo admin login must succeed — run `npm run db:seed` first');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('metaClient.messagingTierCap() maps every documented tier to its real numeric cap, and anything unrecognized to null', () => {
  assert.equal(metaClient.messagingTierCap('TIER_250'), 250);
  assert.equal(metaClient.messagingTierCap('TIER_1K'), 1000);
  assert.equal(metaClient.messagingTierCap('TIER_10K'), 10000);
  assert.equal(metaClient.messagingTierCap('TIER_100K'), 100000);
  assert.equal(metaClient.messagingTierCap('TIER_UNLIMITED'), Infinity);
  assert.equal(metaClient.messagingTierCap('unknown'), null);
  assert.equal(metaClient.messagingTierCap(null), null);
  assert.equal(metaClient.messagingTierCap('SOME_FUTURE_TIER_META_ADDS'), null);
});

test('messagingTierRefreshRunner.refreshOne persists a real tier value and sets messaging_tier_checked_at', async () => {
  await setWabaRow({ messaging_tier: null, messaging_tier_checked_at: null });
  const waba = await wabasRepo.findByClientId(testClientId);

  await withFakeGraphFetch({ display_phone_number: '910000000000', verified_name: 'Test', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' }, async () => {
    const result = await messagingTierRefreshRunner.refreshOne(waba);
    assert.equal(result.ok, true);
    assert.equal(result.tier, 'TIER_1K');
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.equal(updated.messaging_tier, 'TIER_1K');
  assert.ok(updated.messaging_tier_checked_at, 'messaging_tier_checked_at must be set after a real refresh');
});

test('messagingTierRefreshRunner.refreshOne stores "unknown" (not null, not a crash) when Meta omits the field', async () => {
  await setWabaRow({ messaging_tier: null, messaging_tier_checked_at: null });
  const waba = await wabasRepo.findByClientId(testClientId);

  await withFakeGraphFetch({ display_phone_number: '910000000000', verified_name: 'Test', quality_rating: 'GREEN' }, async () => {
    const result = await messagingTierRefreshRunner.refreshOne(waba);
    assert.equal(result.ok, true);
    assert.equal(result.tier, 'unknown');
  });

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.equal(updated.messaging_tier, 'unknown');
  assert.ok(updated.messaging_tier_checked_at, 'checked_at is still set even when the field came back absent — it WAS checked');
});

test('messagingTierRefreshRunner.refreshOne never throws on a Meta failure — returns ok:false instead', async () => {
  await withFakeGraphFetch({ fail: true }, async () => {
    const waba = await wabasRepo.findByClientId(testClientId);
    const result = await messagingTierRefreshRunner.refreshOne(waba);
    assert.equal(result.ok, false);
    assert.ok(result.reason);
  });
});

test('admin POST /clients/:id/refresh-messaging-tier: success path updates and returns the waba', async () => {
  await setWabaRow({ messaging_tier: null, messaging_tier_checked_at: null });

  await withFakeGraphFetch({ display_phone_number: '910000000000', verified_name: 'Test', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_10K' }, async () => {
    const res = await fetch(`${baseUrl}/api/admin/clients/${testClientId}/refresh-messaging-tier`, { method: 'POST', headers: authed(adminToken) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.refreshed, true);
    assert.equal(body.waba.messaging_tier, 'TIER_10K');
    assert.equal(body.waba.access_token_encrypted, undefined, 'maskWaba must still strip the token from this new route\'s response');
  });

  const { rows } = await pool.query(
    `select * from audit_log where actor_type = 'admin' and action = 'messaging_tier_refreshed' and target like $1 order by created_at desc limit 1`,
    [`${testClientId}%`]
  );
  assert.equal(rows.length, 1, 'a successful refresh must be audited');
});

test('admin POST /clients/:id/refresh-messaging-tier: 502 with detail when the Meta call fails', async () => {
  await withFakeGraphFetch({ fail: true }, async () => {
    const res = await fetch(`${baseUrl}/api/admin/clients/${testClientId}/refresh-messaging-tier`, { method: 'POST', headers: authed(adminToken) });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(body.detail);
  });
});

test('metaWebhook handleAccountUpdate: a real messaging_limit_tier in the payload is persisted', async () => {
  await setWabaRow({ messaging_tier: null, messaging_tier_checked_at: null });

  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: TEST_WABA_ID,
      changes: [{ field: 'account_update', value: { phone_number: '910000000000', messaging_limit_tier: 'TIER_100K' } }],
    }],
  };
  const body = JSON.stringify(payload);
  const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
  const res = await fetch(`${baseUrl}/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
  assert.equal(res.status, 200);

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.equal(updated.messaging_tier, 'TIER_100K');
  assert.ok(updated.messaging_tier_checked_at);
});

test('metaWebhook handleAccountUpdate: absent messaging_limit_tier leaves the existing stored tier untouched', async () => {
  await setWabaRow({ messaging_tier: 'TIER_250', messaging_tier_checked_at: new Date() });

  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: TEST_WABA_ID,
      changes: [{ field: 'account_update', value: { phone_number: '910000000000', quality_rating: 'GREEN' } }],
    }],
  };
  const body = JSON.stringify(payload);
  const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
  const res = await fetch(`${baseUrl}/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
  assert.equal(res.status, 200);

  const updated = await wabasRepo.findByClientId(testClientId);
  assert.equal(updated.messaging_tier, 'TIER_250', 'coalesce must keep the prior value when Meta omits the field');
});

test('GET /api/broadcasts/tier-status: unknown tier reports tier:null, no fabricated numbers', async () => {
  await setWabaRow({ messaging_tier: null, messaging_tier_checked_at: null });
  const res = await fetch(`${baseUrl}/api/broadcasts/tier-status`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tier, null);
  assert.equal(body.capNumber, null);
  assert.equal(body.remaining, null);
});

test('GET /api/broadcasts/tier-status: TIER_UNLIMITED reports unlimited:true with no numeric cap', async () => {
  await setWabaRow({ messaging_tier: 'TIER_UNLIMITED', messaging_tier_checked_at: new Date() });
  const res = await fetch(`${baseUrl}/api/broadcasts/tier-status`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tier, 'TIER_UNLIMITED');
  assert.equal(body.unlimited, true);
  assert.equal(body.capNumber, null);
  assert.equal(body.remaining, null);
});

test('GET /api/broadcasts/tier-status: a known tier reports a real capNumber and remaining', async () => {
  await setWabaRow({ messaging_tier: 'TIER_250', messaging_tier_checked_at: new Date() });
  const res = await fetch(`${baseUrl}/api/broadcasts/tier-status`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tier, 'TIER_250');
  assert.equal(body.unlimited, false);
  assert.equal(body.capNumber, 250);
  assert.equal(typeof body.remaining, 'number');
});

// Broadcast preflight tierWarning — exercised against a real tag audience,
// using this suite's own dedicated client/contacts so it can't be affected
// by any other test file's send history. TIER_50 (the smallest real tier)
// is used deliberately so the burn loop below stays small — a tag with 3
// contacts against a cap that's already "used" 48 of 50 (via 48 real
// outbound messages sent in the last 24h to distinct contacts) must warn;
// the same audience against an unknown tier must not.
test('POST /api/broadcasts: tierWarning fires when the real audience would exceed remaining capacity', async () => {
  await setWabaRow({ messaging_tier: 'TIER_50', messaging_tier_checked_at: new Date() });

  // Burn 48 of the 50 cap with real outbound messages to distinct contacts.
  for (let i = 0; i < 48; i++) {
    const chat = await chatsRepo.create(pool, testClientId, { name: `${SUITE_PREFIX}burn_${i}`, phone: `9199999${String(i).padStart(5, '0')}`, unread_count: 0 });
    await chatsRepo.insertOutboundPending(pool, testClientId, chat.id, 'burn');
  }

  const tagRes = await fetch(`${baseUrl}/api/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name: `${SUITE_PREFIX}tag`, bg: '#000', color: '#fff' }) });
  const tag = await tagRes.json();
  for (let i = 0; i < 3; i++) {
    await fetch(`${baseUrl}/api/contacts`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name: `${SUITE_PREFIX}contact_${i}`, phone: `9198888${String(i).padStart(5, '0')}`, tag_id: tag.id }) });
  }

  const res = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ title: `${SUITE_PREFIX}campaign`, tag_id: tag.id, templateName: `${SUITE_PREFIX}nonexistent_template` }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.recipient_count, 3);
  assert.ok(body.tierWarning, 'a 3-recipient broadcast against ~2 remaining slots must warn');
  assert.match(body.tierWarning, /TIER_50/);
});

test('POST /api/broadcasts: no tierWarning when the tier has never been checked', async () => {
  await setWabaRow({ messaging_tier: null, messaging_tier_checked_at: null });

  const tagRes = await fetch(`${baseUrl}/api/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name: `${SUITE_PREFIX}tag2`, bg: '#000', color: '#fff' }) });
  const tag = await tagRes.json();
  await fetch(`${baseUrl}/api/contacts`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name: `${SUITE_PREFIX}contact_solo`, phone: `9197777${Date.now()}`.slice(0, 12), tag_id: tag.id }) });

  const res = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ title: `${SUITE_PREFIX}campaign2`, tag_id: tag.id, templateName: `${SUITE_PREFIX}nonexistent_template` }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.tierWarning, null, 'must never fabricate a warning against a tier this app has never actually checked');
});
