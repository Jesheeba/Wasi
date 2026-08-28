// Real end-to-end integration: the actual Zapier app (this package's real
// authentication.js/triggers/creates), driven through zapier-platform-core's
// own createAppTester, against the REAL Wasi backend (server/src/app.js's
// createApp(), the same Express app production runs) — same pattern and
// same safety rail as mcp-server/test/integration.test.js: a dedicated,
// disposable test client (never the demo one), deleted in after(). ONLY the
// outbound call to graph.facebook.com is faked; every other hop (Zapier
// trigger/create -> z.request -> Express route -> repo -> Postgres) is the
// real, unmodified code path.
//
// Requires ALLOW_SHARED_PRODUCTION_DB=yes-i-understand-the-risk for this one
// invocation (see server/src/utils/dbSafety.js) — there is no separate dev
// database for this project. Run explicitly (`npm run test:integration` in
// this package), not part of a plain `npm test` here, same convention as
// mcp-server.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'server', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const zapier = require('zapier-platform-core');

const { createApp } = require(path.join(__dirname, '..', '..', 'server', 'src', 'app'));
const { pool } = require(path.join(__dirname, '..', '..', 'server', 'src', 'db', 'pool'));
const wabasRepo = require(path.join(__dirname, '..', '..', 'server', 'src', 'repositories', 'wabasRepo'));
const contactsRepo = require(path.join(__dirname, '..', '..', 'server', 'src', 'repositories', 'contactsRepo'));
const chatsRepo = require(path.join(__dirname, '..', '..', 'server', 'src', 'repositories', 'chatsRepo'));
const forwardRunner = require(path.join(__dirname, '..', '..', 'server', 'src', 'services', 'forwardRunner'));

const App = require('../index');
const appTester = zapier.createAppTester(App);

const SUITE_PREFIX = '__test_suite__zapierapp_';
const TEST_WABA_ID = `${SUITE_PREFIX}waba`;

let backendServer;
let backendBaseUrl;
let clientToken;
let testClientId;
let apiKey;
let authData;

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function signedMetaPost(payload) {
  const body = JSON.stringify(payload);
  const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
  return fetch(`${backendBaseUrl}/webhooks/meta`, {
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
          metadata: { display_phone_number: '917339561631', phone_number_id: `${SUITE_PREFIX}phone` },
          contacts: [{ wa_id: phone, profile: { name: 'Zapier App Test Sender' } }],
          messages: [{ from: phone, id: `wamid.zapierapp_${Date.now()}_${Math.random()}`, type: 'text', text: { body: 'hi' }, timestamp: '1786973208' }],
        },
      }],
    }],
  };
}

before(async () => {
  const app = createApp();
  backendServer = app.listen(0);
  await new Promise((resolve) => backendServer.once('listening', resolve));
  backendBaseUrl = `http://localhost:${backendServer.address().port}`;

  const registered = await fetch(`${backendBaseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client`,
      email: `test-suite-zapierapp-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  // The exact real flow a client follows: self-serve create a key via
  // Settings > Developer (routes/apiKeys.js POST /, build plan Phase 4),
  // then paste it into Zapier's own connection dialog.
  const created = await fetch(`${backendBaseUrl}/api/api-keys`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ app_name: `${SUITE_PREFIX}zapier_key` }),
  }).then((r) => r.json());
  apiKey = created.key;
  assert.ok(apiKey, 'self-serve API key creation must succeed');

  authData = { api_key: apiKey, base_url: backendBaseUrl };
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => backendServer.close(resolve));
  await pool.end();
});

test('authentication.test: a valid key resolves this client\'s own account, via the real app instance', async () => {
  const account = await appTester(App.authentication.test, { authData });
  assert.equal(account.client_id, testClientId);
  assert.equal(account.connected, false);
});

test('authentication.test: an invalid key surfaces Hub API v1\'s real error shape, not a bare HTTP status', async () => {
  await assert.rejects(
    () => appTester(App.authentication.test, { authData: { api_key: 'wasi_not_a_real_key', base_url: backendBaseUrl } }),
    /Invalid or revoked API key/i
  );
});

test('New WhatsApp Message Received: subscribe registers a real row, a real inbound message delivers to it with a verifiable signature, unsubscribe stops future deliveries', async () => {
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
  const targetUrl = `http://localhost:${target.address().port}/zap-catch-hook`;

  await wabasRepo.upsertForClient(testClientId, { waba_id: TEST_WABA_ID, status: 'connected' });

  const subscribed = await appTester(App.triggers.new_message_received.operation.performSubscribe, {
    authData, targetUrl,
  });
  assert.ok(subscribed.id, 'performSubscribe must return the created subscription (with id, for performUnsubscribe later)');
  assert.ok(subscribed.secret, 'performSubscribe must return a secret — this is what bundle.subscribeData carries for perform() to verify signatures with');

  const { rows } = await pool.query('select * from zapier_subscriptions where id = $1', [subscribed.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target_url, targetUrl);

  const phone = `91912${Date.now()}`.slice(0, 12);
  const res = await signedMetaPost(inboundMessagePayload(phone));
  assert.equal(res.status, 200);

  const { rows: deliveries } = await pool.query(
    `select * from webhook_deliveries where client_id = $1 and target_url = $2 order by created_at desc limit 1`,
    [testClientId, targetUrl]
  );
  assert.equal(deliveries.length, 1, 'the real inbound message must have enqueued a delivery to the subscribed Zapier target');
  await forwardRunner.deliverOne(deliveries[0]);
  assert.ok(receivedBody, 'forwardRunner must have actually POSTed the event to the Zapier subscription target');

  // This is exactly what Zapier's own platform hands perform(): the real
  // subscribeData it persisted from performSubscribe (secret included), and
  // the real raw HTTP request forwardRunner.js sent (rawRequest.content is
  // the exact byte sequence the signature was computed over, not the
  // already-parsed cleanedRequest) — proving perform() both verifies a
  // genuine signature and correctly unwraps forwardRunner's { event, data }
  // envelope down to just the message fields Zapier should show.
  const results = await appTester(App.triggers.new_message_received.operation.perform, {
    authData,
    subscribeData: subscribed,
    cleanedRequest: JSON.parse(receivedBody),
    rawRequest: { headers: { 'x-wasi-signature-256': receivedSignature }, content: receivedBody },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].contact.wa_id, phone);
  assert.equal(results[0].message.body, 'hi');

  // Independent Auditor finding, now fixed: a forged event with no valid
  // signature must be rejected, not silently accepted as real.
  await assert.rejects(
    () => appTester(App.triggers.new_message_received.operation.perform, {
      authData,
      subscribeData: subscribed,
      cleanedRequest: JSON.parse(receivedBody),
      rawRequest: { headers: { 'x-wasi-signature-256': 'sha256=not_the_real_signature' }, content: receivedBody },
    }),
    /failed signature verification/i
  );
  await assert.rejects(
    () => appTester(App.triggers.new_message_received.operation.perform, {
      authData, subscribeData: subscribed, cleanedRequest: JSON.parse(receivedBody), rawRequest: undefined,
    }),
    /no verifiable signature/i,
    'a request with no signature header at all must also be rejected, not crash or pass through unverified'
  );

  await appTester(App.triggers.new_message_received.operation.performUnsubscribe, {
    authData, subscribeData: { id: subscribed.id },
  });
  const { rows: gone } = await pool.query('select 1 from zapier_subscriptions where id = $1', [subscribed.id]);
  assert.equal(gone.length, 0, 'performUnsubscribe must actually remove the subscription row');

  await new Promise((resolve) => target.close(resolve));
});

test('New WhatsApp Message Received: subscribing the same target_url twice is idempotent, not a duplicate row', async () => {
  await wabasRepo.upsertForClient(testClientId, { waba_id: TEST_WABA_ID, status: 'connected' });
  const targetUrl = `http://localhost:1/zap-dedup-target-${Date.now()}`;

  const first = await appTester(App.triggers.new_message_received.operation.performSubscribe, { authData, targetUrl });
  const second = await appTester(App.triggers.new_message_received.operation.performSubscribe, { authData, targetUrl });
  assert.equal(second.id, first.id, 'a repeat subscribe for the same target_url must reuse the existing row, not create a second one');

  const { rows } = await pool.query('select count(*)::int as n from zapier_subscriptions where client_id = $1 and target_url = $2', [testClientId, targetUrl]);
  assert.equal(rows[0].n, 1);

  await appTester(App.triggers.new_message_received.operation.performUnsubscribe, { authData, subscribeData: { id: first.id } });
});

test('Send WhatsApp Message (text): real round trip captures the exact Graph API payload, only graph.facebook.com faked', async () => {
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: TEST_WABA_ID, phone_number_id: `${SUITE_PREFIX}phone`, status: 'connected',
    access_token_encrypted: require(path.join(__dirname, '..', '..', 'server', 'src', 'utils', 'encryption')).encrypt('fake-token-never-sent-to-meta'),
  });
  const phone = `91913${Date.now()}`.slice(0, 12);
  const contact = await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: 'Zapier App Text Contact', wa_id: phone });
  const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
  // Opens the 24h session window — same setup mcp-server's send_button_message
  // integration test uses, for the same reason (a text send is otherwise
  // correctly rejected with session_window_closed).
  await chatsRepo.insertInbound(pool, testClientId, chat.id, {
    metaMessageId: `wamid.zapierapp_text_${Date.now()}`, body: 'hi', sentAt: new Date().toISOString(),
  });

  const originalFetch = global.fetch;
  let capturedRequest = null;
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    capturedRequest = { url: String(url), body: JSON.parse(options.body) };
    // zapier-platform-core patches global.fetch process-wide (not just for
    // its own z.request() calls) to log every outbound request — including
    // this server's own metaClient.js -> fetch() call, since it runs in the
    // same process as this test. Its logging wrapper iterates the real
    // Headers API (.get, .entries), so a fake response needs a real
    // Headers instance, not a plain object, or it throws from INSIDE
    // zapier-platform-core, not from this app's own code — confirmed by
    // tracing the stack through
    // node_modules/zapier-platform-core/src/tools/fetch-logger.js. Not an
    // issue for mcp-server's equivalent test, which never loads
    // zapier-platform-core.
    return {
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({ messages: [{ id: 'wamid.ZAPIER_APP_FAKE_ID' }] }),
    };
  };

  let message;
  try {
    message = await appTester(App.creates.send_message.operation.perform, {
      authData, inputData: { to: phone, message_type: 'text', body: 'Your order has shipped!' },
    });
  } finally {
    global.fetch = originalFetch;
    await wabasRepo.upsertForClient(testClientId, { status: 'disconnected' });
  }

  assert.equal(message.status, 'sent');
  assert.equal(message.meta_message_id, 'wamid.ZAPIER_APP_FAKE_ID');
  assert.ok(capturedRequest, 'the create action must have actually reached the Graph API call path (via POST /api/v1/messages -> messagingService)');
  assert.equal(capturedRequest.body.text.body, 'Your order has shipped!');
});

test('Send WhatsApp Message (template, invalid params JSON): rejected before any network call, with a clear message', async () => {
  await assert.rejects(
    () => appTester(App.creates.send_message.operation.perform, {
      authData, inputData: { to: '919999999999', message_type: 'template', template_name: 'order_update', params: '{not valid json' },
    }),
    /Template Parameters must be valid JSON/i
  );
});
