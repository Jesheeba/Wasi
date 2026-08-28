// Independent QA pass (Phase 4 Zapier integration) — regression tests for
// real gaps found by adversarial testing, NOT covered by
// apiV1Subscriptions.test.js. Originally written to PASS while proving each
// defect existed (per this file's own stated convention: "if a fix ships,
// the relevant assertion should be flipped/removed as part of that fix").
// All four were fixed the same session (revoke/delete now clean up
// zapier_subscriptions rows explicitly — routes/apiKeys.js;
// zapierSubscribeSchema now rejects link-local target_url and non-http(s)
// schemes — utils/validate.js; create() upserts on (client_id, target_url,
// event) — migration 041/zapierSubscriptionsRepo.js) — assertions below are
// flipped to prove the fixes instead.
//
// Same dedicated-disposable-test-client + fake-waba pattern as
// apiV1Subscriptions.test.js and webhookForwarding.test.js.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');

let server;
let baseUrl;
let testClientId;
let clientToken;

const SUITE_PREFIX = '__test_suite__zapiersubsgaps_';
const TEST_WABA_ID = 'test_suite_zapiersubsgaps_waba_id';

function authedJson(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function signedMetaPost(payload) {
  const body = JSON.stringify(payload);
  const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
  return fetch(`${baseUrl}/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
}

function inboundMessagePayload(phone) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: TEST_WABA_ID,
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '917339561631', phone_number_id: 'test_suite_zapiersubsgaps_phone_id' },
          contacts: [{ wa_id: phone, profile: { name: 'Zapier Subs Gaps Test Sender' } }],
          messages: [{ from: phone, id: `wamid.zapiersubsgaps_${Date.now()}_${Math.random()}`, type: 'text', text: { body: 'hi' }, timestamp: '1786973208' }],
        },
      }],
    }],
  };
}

async function issueSelfServeKey(appName) {
  return fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: authedJson(clientToken),
    body: JSON.stringify({ app_name: appName }),
  }).then((r) => r.json());
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
      email: `test-suite-zapiersubsgaps-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  testClientId = registered.client?.id;
  clientToken = registered.token;
  assert.ok(testClientId && clientToken, 'dedicated test client must be created');

  await wabasRepo.upsertForClient(testClientId, { waba_id: TEST_WABA_ID, status: 'connected' });
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('FIXED: revoking the owning API key now actually stops its Zapier subscription from receiving live events', async () => {
  const key = await issueSelfServeKey(`${SUITE_PREFIX}revoke_key`);
  // Need a second active key so revoke isn't blocked by the last-active-key guard.
  await issueSelfServeKey(`${SUITE_PREFIX}revoke_key_spare`);

  const targetUrl = 'http://127.0.0.1:1/revoked-key-target';
  const sub = await fetch(`${baseUrl}/api/v1/subscriptions`, {
    method: 'POST', headers: authedJson(key.key), body: JSON.stringify({ target_url: targetUrl }),
  }).then((r) => r.json());
  assert.ok(sub.id);

  const revokeRes = await fetch(`${baseUrl}/api/api-keys/${key.id}/revoke`, { method: 'POST', headers: authedJson(clientToken) });
  assert.equal(revokeRes.status, 200);

  // The revoked key itself can no longer authenticate.
  const authCheck = await fetch(`${baseUrl}/api/v1/account`, { headers: { Authorization: `Bearer ${key.key}` } });
  assert.equal(authCheck.status, 401, 'sanity check: the revoked key must fail Hub API auth');

  // routes/apiKeys.js's POST /:id/revoke now explicitly calls
  // zapierSubscriptionsRepo.removeByApiKeyId, since revoke() only ever sets
  // revoked_at (never a real SQL DELETE), so migration 040's api_key_id
  // ON DELETE CASCADE never fires on its own.
  const { rows: subRows } = await pool.query('select 1 from zapier_subscriptions where id = $1', [sub.id]);
  assert.equal(subRows.length, 0, 'the subscription row must be gone immediately after revoke, not just inert');

  const phone = `91930${Date.now()}`.slice(0, 12);
  const res = await signedMetaPost(inboundMessagePayload(phone));
  assert.equal(res.status, 200);

  const { rows } = await pool.query(
    `select id from webhook_deliveries where client_id = $1 and target_url = $2`,
    [testClientId, targetUrl]
  );
  assert.equal(rows.length, 0, 'FIX PROOF: no delivery is enqueued to a subscription owned by a REVOKED key — ' +
    'revoking a compromised/rotated key now actually cuts off its Zapier integration from live WhatsApp data.');
});

test('FIXED: soft-deleting (DELETE /api/api-keys/:id) the owning API key ALSO now stops its Zapier subscription', async () => {
  const key = await issueSelfServeKey(`${SUITE_PREFIX}delete_key`);
  await issueSelfServeKey(`${SUITE_PREFIX}delete_key_spare`);

  const targetUrl = 'http://127.0.0.1:1/soft-deleted-key-target';
  const sub = await fetch(`${baseUrl}/api/v1/subscriptions`, {
    method: 'POST', headers: authedJson(key.key), body: JSON.stringify({ target_url: targetUrl }),
  }).then((r) => r.json());

  const deleteRes = await fetch(`${baseUrl}/api/api-keys/${key.id}`, { method: 'DELETE', headers: authedJson(clientToken) });
  assert.equal(deleteRes.status, 200);

  const { rows: subRows } = await pool.query('select 1 from zapier_subscriptions where id = $1', [sub.id]);
  assert.equal(subRows.length, 0);

  const phone = `91931${Date.now()}`.slice(0, 12);
  const res = await signedMetaPost(inboundMessagePayload(phone));
  assert.equal(res.status, 200);

  const { rows } = await pool.query(
    `select id from webhook_deliveries where client_id = $1 and target_url = $2`,
    [testClientId, targetUrl]
  );
  assert.equal(rows.length, 0, 'FIX PROOF: apiKeysRepo.softDelete\'s caller (routes/apiKeys.js DELETE /:id) now explicitly ' +
    'removes the subscription too — it no longer keeps receiving events forever after a client deletes the key.');
});

test('FIXED (partial, by design): POST /api/v1/subscriptions now rejects the cloud-metadata/link-local endpoint and non-http schemes', async () => {
  const key = await issueSelfServeKey(`${SUITE_PREFIX}ssrf_key`);
  const rejected = [
    'http://169.254.169.254/latest/meta-data/', // cloud metadata endpoint — the real-world exploited case
    'ftp://example.com/x',
    'file:///etc/passwd',
  ];
  for (const target_url of rejected) {
    const res = await fetch(`${baseUrl}/api/v1/subscriptions`, {
      method: 'POST', headers: authedJson(key.key), body: JSON.stringify({ target_url }),
    });
    assert.equal(res.status, 400, `FIX PROOF: "${target_url}" must now be rejected by zapierSubscribeSchema.`);
  }

  // Deliberately still accepted, not a regression: this project's own
  // webhook-forwarding test suite (webhookForwarding.test.js,
  // apiV1Subscriptions.test.js) depends on subscribing real
  // http.createServer instances on loopback to capture and verify
  // deliveries. Full private-range/loopback blocking needs an env-gated
  // bypass to keep that pattern working — a real, larger follow-up
  // documented in CLAUDE.md Known Gaps, not silently dropped. The identical
  // gap already exists, unaddressed, on wabas.forward_to_url/client_webhooks'
  // callback_url (same bare z.string().url()) — inherited, not introduced.
  const stillAccepted = ['http://127.0.0.1/steal', 'http://localhost/steal', 'http://0.0.0.0/steal'];
  const createdIds = [];
  for (const target_url of stillAccepted) {
    const res = await fetch(`${baseUrl}/api/v1/subscriptions`, {
      method: 'POST', headers: authedJson(key.key), body: JSON.stringify({ target_url }),
    });
    assert.equal(res.status, 201);
    createdIds.push((await res.json()).id);
  }
  for (const id of createdIds) await pool.query('delete from zapier_subscriptions where id = $1', [id]);
});

test('FIXED: subscribing the same target_url twice is idempotent — no duplicate row, no double delivery', async () => {
  const key = await issueSelfServeKey(`${SUITE_PREFIX}dup_key`);
  const targetUrl = 'http://127.0.0.1:1/dup-target';

  const sub1 = await fetch(`${baseUrl}/api/v1/subscriptions`, {
    method: 'POST', headers: authedJson(key.key), body: JSON.stringify({ target_url: targetUrl }),
  }).then((r) => r.json());
  const sub2 = await fetch(`${baseUrl}/api/v1/subscriptions`, {
    method: 'POST', headers: authedJson(key.key), body: JSON.stringify({ target_url: targetUrl }),
  }).then((r) => r.json());
  assert.equal(sub2.id, sub1.id, 'FIX PROOF: a repeat subscribe for the identical target_url now reuses the existing row (migration 041 unique constraint + upsert), not a second one');
  assert.equal(sub2.secret, sub1.secret, 'the original secret must be preserved across an idempotent re-subscribe');

  const phone = `91932${Date.now()}`.slice(0, 12);
  const res = await signedMetaPost(inboundMessagePayload(phone));
  assert.equal(res.status, 200);

  const { rows } = await pool.query(
    `select id from webhook_deliveries where client_id = $1 and target_url = $2`,
    [testClientId, targetUrl]
  );
  assert.equal(rows.length, 1, 'FIX PROOF: ONE inbound message now produces exactly ONE webhook_deliveries row for the same target_url, not two.');

  await pool.query('delete from zapier_subscriptions where client_id = $1 and target_url = $2', [testClientId, targetUrl]);
  await pool.query('delete from webhook_deliveries where client_id = $1 and target_url = $2', [testClientId, targetUrl]);
});

test('confirmed OK: unsubscribing does not retroactively cancel a delivery that was already enqueued before the unsubscribe', async () => {
  // Documented as acceptable per the build's own review scope ("they were
  // already queued, so they'll fire once more") — this test proves that is
  // in fact the real, current behavior, not an assumption.
  const key = await issueSelfServeKey(`${SUITE_PREFIX}orphan_key`);
  const targetUrl = 'http://127.0.0.1:1/orphan-target';
  const sub = await fetch(`${baseUrl}/api/v1/subscriptions`, {
    method: 'POST', headers: authedJson(key.key), body: JSON.stringify({ target_url: targetUrl }),
  }).then((r) => r.json());

  const phone = `91933${Date.now()}`.slice(0, 12);
  await signedMetaPost(inboundMessagePayload(phone));

  const { rows: before } = await pool.query(
    `select id, status from webhook_deliveries where client_id = $1 and target_url = $2`, [testClientId, targetUrl]
  );
  assert.equal(before.length, 1);
  assert.equal(before[0].status, 'pending');

  const unsubRes = await fetch(`${baseUrl}/api/v1/subscriptions/${sub.id}`, { method: 'DELETE', headers: authedJson(key.key) });
  assert.equal(unsubRes.status, 200);

  const { rows: after } = await pool.query(
    `select id, status from webhook_deliveries where client_id = $1 and target_url = $2`, [testClientId, targetUrl]
  );
  assert.equal(after.length, 1, 'the already-enqueued pending delivery is NOT cleaned up by unsubscribe — it remains queued and will still fire once');
  assert.equal(after[0].status, 'pending');

  await pool.query('delete from webhook_deliveries where client_id = $1 and target_url = $2', [testClientId, targetUrl]);
});
