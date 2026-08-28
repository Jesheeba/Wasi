// Zapier REST Hook subscribe/unsubscribe (build plan Phase 4, routes/
// apiV1Subscriptions.js) — this is Hub API v1 surface, so it's authenticated
// with a Bearer API key (requireApiKey), not a client JWT, same as every
// other /api/v1/* route. Covers: subscribing registers a row that actually
// receives a real forwarded message.received event through the existing
// webhook_deliveries/forwardRunner pipeline (routes/metaWebhook.js's
// enqueueForwards), unsubscribing actually stops future deliveries, and the
// usual tenant-isolation/auth-rejection cases. Same dedicated-disposable-
// test-client + fake-waba pattern as webhookForwarding.test.js.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const forwardRunner = require('../src/services/forwardRunner');

let server;
let baseUrl;
let testClientId;
let clientToken;
let apiKey;
let otherClientId;
let otherClientToken;
let otherApiKey;

const SUITE_PREFIX = '__test_suite__zapiersubs_';
const TEST_WABA_ID = 'test_suite_zapiersubs_waba_id';

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
          metadata: { display_phone_number: '917339561631', phone_number_id: 'test_suite_zapiersubs_phone_id' },
          contacts: [{ wa_id: phone, profile: { name: 'Zapier Subs Test Sender' } }],
          messages: [{ from: phone, id: `wamid.zapiersubs_${Date.now()}_${Math.random()}`, type: 'text', text: { body: 'hi' }, timestamp: '1786973208' }],
        },
      }],
    }],
  };
}

async function registerClientWithKey(suffix) {
  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client_${suffix}`,
      email: `test-suite-zapiersubs-${suffix}-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  const created = await fetch(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: authedJson(registered.token),
    body: JSON.stringify({ app_name: `${SUITE_PREFIX}zapier_${suffix}` }),
  }).then((r) => r.json());
  return { clientId: registered.client?.id, clientToken: registered.token, apiKey: created.key };
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const primary = await registerClientWithKey('primary');
  testClientId = primary.clientId;
  clientToken = primary.clientToken;
  apiKey = primary.apiKey;
  assert.ok(testClientId && apiKey, 'dedicated test client + API key must be created');

  const other = await registerClientWithKey('other');
  otherClientId = other.clientId;
  otherClientToken = other.clientToken;
  otherApiKey = other.apiKey;
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  if (otherClientId) await pool.query('delete from clients where id = $1', [otherClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('POST /api/v1/subscriptions requires a valid bearer API key', async () => {
  const res = await fetch(`${baseUrl}/api/v1/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_url: 'https://hooks.zapier.com/hooks/standard/test/' }),
  });
  assert.equal(res.status, 401);
});

test('POST /api/v1/subscriptions creates a row scoped to the calling key\'s own client, returning a secret', async () => {
  const res = await fetch(`${baseUrl}/api/v1/subscriptions`, {
    method: 'POST',
    headers: authedJson(apiKey),
    body: JSON.stringify({ target_url: 'https://hooks.zapier.com/hooks/standard/test-scope/' }),
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.client_id, testClientId);
  assert.equal(created.event, 'message.received');
  assert.ok(created.secret, 'a fresh HMAC secret must be returned for this subscription');

  const { rows } = await pool.query('select * from zapier_subscriptions where id = $1', [created.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client_id, testClientId);
  await pool.query('delete from zapier_subscriptions where id = $1', [created.id]);
});

test('POST /api/v1/subscriptions rejects a non-URL target_url', async () => {
  const res = await fetch(`${baseUrl}/api/v1/subscriptions`, {
    method: 'POST',
    headers: authedJson(apiKey),
    body: JSON.stringify({ target_url: 'not-a-url' }),
  });
  assert.equal(res.status, 400);
});

test('a real message.received event delivers to an active Zapier subscription through the existing forward queue', async () => {
  let receivedBody, receivedSignature;
  const target = http.createServer((req, res) => {
    let chunks = '';
    req.on('data', (c) => { chunks += c; });
    req.on('end', () => {
      receivedBody = chunks;
      receivedSignature = req.headers['x-wasi-signature-256'];
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((resolve) => target.listen(0, resolve));
  const targetUrl = `http://localhost:${target.address().port}/zap-hook`;

  await wabasRepo.upsertForClient(testClientId, { waba_id: TEST_WABA_ID, status: 'connected' });

  const subscribed = await fetch(`${baseUrl}/api/v1/subscriptions`, {
    method: 'POST',
    headers: authedJson(apiKey),
    body: JSON.stringify({ target_url: targetUrl }),
  }).then((r) => r.json());

  const phone = `91910${Date.now()}`.slice(0, 12);
  const res = await signedMetaPost(inboundMessagePayload(phone));
  assert.equal(res.status, 200);

  const { rows } = await pool.query(
    `select * from webhook_deliveries where client_id = $1 and target_url = $2 order by created_at desc limit 1`,
    [testClientId, targetUrl]
  );
  assert.equal(rows.length, 1, 'the Zapier subscription must enqueue into the exact same webhook_deliveries queue as every other forward target');
  const delivery = rows[0];
  assert.equal(delivery.target_secret, subscribed.secret);

  await forwardRunner.deliverOne(delivery);

  assert.ok(receivedBody, 'forwardRunner must deliver to the Zapier subscription target, not just wabas/client_webhooks targets');
  const expectedSignature = 'sha256=' + crypto.createHmac('sha256', subscribed.secret).update(receivedBody).digest('hex');
  assert.equal(receivedSignature, expectedSignature);
  const parsed = JSON.parse(receivedBody);
  assert.equal(parsed.event, 'message.received');
  assert.equal(parsed.data.contact.wa_id, phone);

  await fetch(`${baseUrl}/api/v1/subscriptions/${subscribed.id}`, { method: 'DELETE', headers: authedJson(apiKey) });
  await new Promise((resolve) => target.close(resolve));
});

test('DELETE /api/v1/subscriptions/:id actually stops future deliveries, not just the row', async () => {
  await wabasRepo.upsertForClient(testClientId, { waba_id: TEST_WABA_ID, status: 'connected' });

  const subscribed = await fetch(`${baseUrl}/api/v1/subscriptions`, {
    method: 'POST',
    headers: authedJson(apiKey),
    body: JSON.stringify({ target_url: 'http://127.0.0.1:1/unsubscribed-target' }),
  }).then((r) => r.json());

  const unsubRes = await fetch(`${baseUrl}/api/v1/subscriptions/${subscribed.id}`, {
    method: 'DELETE',
    headers: authedJson(apiKey),
  });
  assert.equal(unsubRes.status, 200);

  const { rows: gone } = await pool.query('select 1 from zapier_subscriptions where id = $1', [subscribed.id]);
  assert.equal(gone.length, 0);

  const phone = `91911${Date.now()}`.slice(0, 12);
  const res = await signedMetaPost(inboundMessagePayload(phone));
  assert.equal(res.status, 200);

  const { rows: deliveries } = await pool.query(
    `select 1 from webhook_deliveries where client_id = $1 and target_url = 'http://127.0.0.1:1/unsubscribed-target'`,
    [testClientId]
  );
  assert.equal(deliveries.length, 0, 'an unsubscribed target must never receive another delivery');
});

test('a client cannot unsubscribe another client\'s Zapier subscription', async () => {
  const subscribed = await fetch(`${baseUrl}/api/v1/subscriptions`, {
    method: 'POST',
    headers: authedJson(apiKey),
    body: JSON.stringify({ target_url: 'http://127.0.0.1:1/cross-tenant-target' }),
  }).then((r) => r.json());

  const crossRes = await fetch(`${baseUrl}/api/v1/subscriptions/${subscribed.id}`, {
    method: 'DELETE',
    headers: authedJson(otherApiKey),
  });
  assert.equal(crossRes.status, 404);

  const { rows } = await pool.query('select 1 from zapier_subscriptions where id = $1', [subscribed.id]);
  assert.equal(rows.length, 1, 'the subscription must survive the foreign client\'s unsubscribe attempt');

  await fetch(`${baseUrl}/api/v1/subscriptions/${subscribed.id}`, { method: 'DELETE', headers: authedJson(apiKey) });
});
