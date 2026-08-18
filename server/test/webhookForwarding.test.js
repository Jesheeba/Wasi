// Hub inbound forwarding (build plan Phase 5). Covers: a forward fires with
// a correct HMAC signature, a forward failure never changes the response
// given to Meta (the whole reason the delivery attempt is decoupled into
// forwardRunner.js instead of awaited inline in metaWebhook.js), a failed
// delivery is retried with backoff rather than dropped, and — since
// routes/metaWebhook.js's enqueueForwards unifies both forward targets
// into this one queue — that client_webhooks (the client's own
// self-configured integration webhook) goes through the exact same
// durable, retried path as wabas.forward_to_url now, not the fire-and-
// forget fetch it used to be, and that a client with both configured gets
// one delivery per target for the same event. Dedicated test client + a
// fake waba_id, same pattern as metaWebhookDispatch.test.js — this WABA is
// never given a real access token, so nothing here can reach a real phone
// or a real Meta call.
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

const SUITE_PREFIX = '__test_suite__forwarding_';
const TEST_WABA_ID = 'test_suite_forwarding_waba_id';
const FORWARD_SECRET = 'test-suite-forward-secret';

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
          metadata: { display_phone_number: '917339561631', phone_number_id: 'test_suite_forwarding_phone_id' },
          contacts: [{ wa_id: phone, profile: { name: 'Forward Test Sender' } }],
          messages: [{ from: phone, id: `wamid.forward_${Date.now()}_${Math.random()}`, type: 'text', text: { body: 'hi' }, timestamp: '1786973208' }],
        },
      }],
    }],
  };
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
      email: `test-suite-forwarding-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  testClientId = registered.client?.id;
  clientToken = registered.token;
  assert.ok(testClientId && clientToken, 'dedicated test client registration must succeed');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('1. an inbound message enqueues a delivery, and forwardRunner delivers it with a correct HMAC signature', async () => {
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
  const targetUrl = `http://localhost:${target.address().port}/hook`;

  const waba = await wabasRepo.upsertForClient(testClientId, {
    waba_id: TEST_WABA_ID,
    status: 'connected',
    forward_to_url: targetUrl,
    forward_secret: FORWARD_SECRET,
    forward_events: ['message.received'],
  });

  const phone = `91905${Date.now()}`.slice(0, 12);
  const res = await signedMetaPost(inboundMessagePayload(phone));
  assert.equal(res.status, 200);

  const { rows } = await pool.query(
    `select * from webhook_deliveries where client_id = $1 and event = 'message.received' order by created_at desc limit 1`,
    [testClientId]
  );
  assert.equal(rows.length, 1, 'an inbound message on a waba with forward_to_url set must enqueue a delivery');
  const delivery = rows[0];
  assert.equal(delivery.status, 'pending');
  assert.equal(delivery.target_url, targetUrl);

  await forwardRunner.deliverOne(delivery);

  assert.ok(receivedBody, 'forwardRunner must have actually POSTed to the target');
  const expectedSignature = 'sha256=' + crypto.createHmac('sha256', FORWARD_SECRET).update(receivedBody).digest('hex');
  assert.equal(receivedSignature, expectedSignature);
  const parsed = JSON.parse(receivedBody);
  assert.equal(parsed.event, 'message.received');

  const { rows: after } = await pool.query('select status, delivered_at from webhook_deliveries where id = $1', [delivery.id]);
  assert.equal(after[0].status, 'delivered');
  assert.ok(after[0].delivered_at);

  await new Promise((resolve) => target.close(resolve));
});

test('2. a forward failure does not change the 200 Meta receives, and is retried with backoff, not dropped', async () => {
  // Unreachable on purpose (connection refused) — the forward target being
  // completely dead is the failure mode this is actually protecting against.
  const deadUrl = 'http://127.0.0.1:1/dead';

  const waba = await wabasRepo.upsertForClient(testClientId, {
    waba_id: TEST_WABA_ID,
    forward_to_url: deadUrl,
    forward_secret: FORWARD_SECRET,
    forward_events: ['message.received'],
  });

  const phone = `91906${Date.now()}`.slice(0, 12);
  const res = await signedMetaPost(inboundMessagePayload(phone));
  // The whole point: a forward target being completely unreachable must
  // never be visible in the response Meta gets for this delivery.
  assert.equal(res.status, 200);

  const { rows } = await pool.query(
    `select * from webhook_deliveries where client_id = $1 and target_url = $2 order by created_at desc limit 1`,
    [testClientId, deadUrl]
  );
  assert.equal(rows.length, 1);
  const delivery = rows[0];
  assert.equal(delivery.attempt_count, 0, 'not yet attempted — only forwardRunner.deliverOne attempts it, not the webhook request');

  await forwardRunner.deliverOne(delivery);

  const { rows: after } = await pool.query('select * from webhook_deliveries where id = $1', [delivery.id]);
  assert.equal(after[0].status, 'pending', 'a single failure must reschedule, not give up (MAX_ATTEMPTS is 5)');
  assert.equal(after[0].attempt_count, 1);
  assert.ok(after[0].last_error, 'the failure reason must be recorded, not silently dropped');
  assert.ok(
    new Date(after[0].next_attempt_at).getTime() > Date.now(),
    'next_attempt_at must be pushed into the future — a backoff, not an immediate retry'
  );
});

test('3. client_webhooks (the client\'s own generic webhook) is delivered through the same durable queue, not a fire-and-forget fetch', async () => {
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
  const targetUrl = `http://localhost:${target.address().port}/client-hook`;

  // No wabas.forward_to_url this time — isolates the client_webhooks path.
  // forward_events must go to null alongside it — migration
  // 015_explicit_forward_events.js's CHECK requires both null or both set.
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: TEST_WABA_ID,
    forward_to_url: null,
    forward_secret: null,
    forward_events: null,
  });

  const configured = await fetch(`${baseUrl}/api/client-webhook`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_url: targetUrl, events: ['message.received'] }),
  }).then((r) => r.json());
  assert.ok(configured.secret, 'client_webhook config must have generated a secret');

  const phone = `91907${Date.now()}`.slice(0, 12);
  const res = await signedMetaPost(inboundMessagePayload(phone));
  assert.equal(res.status, 200);

  const { rows } = await pool.query(
    `select * from webhook_deliveries where client_id = $1 and target_url = $2 order by created_at desc limit 1`,
    [testClientId, targetUrl]
  );
  assert.equal(rows.length, 1, 'client_webhooks must enqueue into webhook_deliveries, same as the hub target');
  const delivery = rows[0];
  assert.equal(delivery.target_secret, configured.secret);

  await forwardRunner.deliverOne(delivery);

  assert.ok(receivedBody, 'forwardRunner must deliver client_webhooks targets too, not just wabas.forward_to_url');
  const expectedSignature = 'sha256=' + crypto.createHmac('sha256', configured.secret).update(receivedBody).digest('hex');
  assert.equal(receivedSignature, expectedSignature);

  const { rows: after } = await pool.query('select status from webhook_deliveries where id = $1', [delivery.id]);
  assert.equal(after[0].status, 'delivered');

  await new Promise((resolve) => target.close(resolve));
});

test('4. a client with both a hub forward target and their own client_webhook configured gets one delivery per target', async () => {
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: TEST_WABA_ID,
    forward_to_url: 'http://127.0.0.1:1/hub-target',
    forward_secret: FORWARD_SECRET,
    forward_events: ['message.received'],
  });
  // client_webhooks was already configured by test 3 above (upsert, so this
  // just confirms it's still set — one row per client_id, not re-created).
  const webhook = await fetch(`${baseUrl}/api/client-webhook`, {
    headers: { Authorization: `Bearer ${clientToken}` },
  }).then((r) => r.json());
  assert.ok(webhook?.callback_url, 'client_webhooks config from test 3 must still be present');

  const phone = `91908${Date.now()}`.slice(0, 12);
  const beforeCount = await pool.query(
    `select count(*)::int as n from webhook_deliveries where client_id = $1`, [testClientId]
  );

  const res = await signedMetaPost(inboundMessagePayload(phone));
  assert.equal(res.status, 200);

  const afterCount = await pool.query(
    `select count(*)::int as n from webhook_deliveries where client_id = $1`, [testClientId]
  );
  assert.equal(
    afterCount.rows[0].n - beforeCount.rows[0].n, 2,
    'one inbound message with both targets configured must enqueue exactly two deliveries, not one or zero'
  );
});

test('5. a target subscribed to a different event does not receive one it never asked for', async () => {
  // Subscribed only to message_template_status_update — an inbound message
  // (message.received) must NOT enqueue a delivery for it. This is the
  // actual proof for the concern that started this file: unifying the two
  // forward mechanisms must not silently widen what an existing subscriber
  // receives.
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: TEST_WABA_ID,
    forward_to_url: 'http://127.0.0.1:1/narrow-target',
    forward_secret: FORWARD_SECRET,
    forward_events: ['message_template_status_update'],
  });
  await fetch(`${baseUrl}/api/client-webhook`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_url: 'http://127.0.0.1:1/narrow-client-hook', events: ['message_template_status_update'] }),
  });

  const phone = `91909${Date.now()}`.slice(0, 12);
  const res = await signedMetaPost(inboundMessagePayload(phone));
  assert.equal(res.status, 200);

  const { rows } = await pool.query(
    `select * from webhook_deliveries where client_id = $1 and event = 'message.received'
     and target_url in ('http://127.0.0.1:1/narrow-target', 'http://127.0.0.1:1/narrow-client-hook')`,
    [testClientId]
  );
  assert.equal(rows.length, 0, 'neither target subscribed only to message_template_status_update should get a message.received delivery');
});

test('6. the DB rejects a forward target configured with no events, or with an unknown event name', async () => {
  await assert.rejects(
    () => wabasRepo.upsertForClient(testClientId, {
      waba_id: TEST_WABA_ID,
      forward_to_url: 'http://127.0.0.1:1/incomplete',
      forward_secret: FORWARD_SECRET,
      forward_events: null,
    }),
    /check constraint|wabas_forward_config_complete_check/i
  );

  const badConfig = await fetch(`${baseUrl}/api/client-webhook`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_url: 'http://127.0.0.1:1/bad', events: ['not_a_real_event'] }),
  });
  assert.equal(badConfig.status, 400, 'an unknown event name must be rejected by request validation, not silently accepted');
});
