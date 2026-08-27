// Hub API (build plan Phase 5): API key auth, and proof that the send
// endpoint enforces the same guards as the internal chat-send path by
// reusing messagingService.sendChatMessage rather than a second copy of
// them. Dedicated, disposable test client, never the demo client — see
// api.test.js's before() comment for why. This client never gets a real
// WABA, so every send below eventually reaches 'waba_not_connected' unless
// an earlier guard blocks it first — that's the whole point: which guard
// fires (or doesn't) first is exactly what's under test.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const { encrypt } = require('../src/utils/encryption');

let server;
let baseUrl;
let clientToken;
let testClientId;
let adminToken;
let apiKey;
let apiKeyId;

const SUITE_PREFIX = '__test_suite__apiv1_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
function apiAuthed(key) {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function createContact(phone, name = 'API v1 Test Contact') {
  return fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name, phone }),
  }).then((r) => r.json());
}

async function createTemplate(category, name = `${SUITE_PREFIX}template_${Date.now()}_${Math.random().toString(36).slice(2)}`) {
  return fetch(`${baseUrl}/api/templates`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({
      name,
      category,
      body: 'Hello {{customer_name}}, thank you so much for reaching out to us today — we truly appreciate it!',
      bodyParamExamples: { customer_name: 'Riyaz' },
    }),
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
      email: `test-suite-apiv1-${Date.now()}@wasi.local`,
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
  apiKeyId = created.id;
  assert.ok(apiKey && apiKeyId, 'api key creation via the admin route must succeed');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('1. a valid API key authenticates', async () => {
  const res = await fetch(`${baseUrl}/api/v1/templates`, { headers: apiAuthed(apiKey) });
  assert.equal(res.status, 200);
});

test('2. a missing/garbage API key is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/v1/templates`, { headers: apiAuthed('not-a-real-key') });
  assert.equal(res.status, 401);
});

test('3. a revoked API key is rejected', async () => {
  const revokeRes = await fetch(`${baseUrl}/api/admin/api-keys/${apiKeyId}/revoke`, {
    method: 'POST',
    headers: authed(adminToken),
    body: JSON.stringify({ client_id: testClientId }),
  });
  assert.equal(revokeRes.status, 200);

  const res = await fetch(`${baseUrl}/api/v1/templates`, { headers: apiAuthed(apiKey) });
  assert.equal(res.status, 401);

  // Re-issue for the remaining tests in this file — this key is dead now.
  const reissued = await fetch(`${baseUrl}/api/admin/api-keys`, {
    method: 'POST',
    headers: authed(adminToken),
    body: JSON.stringify({ client_id: testClientId, app_name: `${SUITE_PREFIX}app_2` }),
  }).then((r) => r.json());
  apiKey = reissued.key;
});

test('4. client_id in the body must match the API key\'s own client', async () => {
  const contact = await createContact(`91900${Date.now()}`.slice(0, 12));
  const otherClientId = '00000000-0000-0000-0000-000000000099';
  const res = await fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: apiAuthed(apiKey),
    body: JSON.stringify({ client_id: otherClientId, to: contact.phone, type: 'text', body: 'hi' }),
  });
  assert.equal(res.status, 403);
});

test('5. send reuses the 24-hour session-window guard', async () => {
  const contact = await createContact(`91901${Date.now()}`.slice(0, 12));
  const res = await fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: apiAuthed(apiKey),
    body: JSON.stringify({ client_id: testClientId, to: contact.phone, type: 'text', body: 'hi' }),
  });
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, 'session_window_closed');
});

test('6. send reuses the Phase 4 opt-in consent guard for marketing templates', async () => {
  const contact = await createContact(`91902${Date.now()}`.slice(0, 12));
  assert.equal(contact.opt_in_status, 'unknown');
  const template = await createTemplate('Marketing');

  const res = await fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: apiAuthed(apiKey),
    body: JSON.stringify({ client_id: testClientId, to: contact.phone, type: 'template', template: template.name }),
  });
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, 'consent_required');
});

test('7. with no guard blocking it, send reaches (and is stopped only by) the real send attempt', async () => {
  // Must run before test 8 below — that test leaves this client's
  // subscription/usage in an over-limit state for the rest of the file, so
  // this baseline needs to run while there's still no active subscription
  // at all, or it would hit plan_limit_reached instead of the WABA check.
  const contact = await createContact(`91904${Date.now()}`.slice(0, 12));
  const template = await createTemplate('Utility');
  const res = await fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: apiAuthed(apiKey),
    body: JSON.stringify({ client_id: testClientId, to: contact.phone, type: 'template', template: template.name }),
  });
  // 409 with code waba_not_connected — same status chats.js's internal send
  // route uses for every MessagingError except 'send_failed' (502 is
  // reserved for an attempt that actually reached Meta and failed there;
  // this test client was never connected, so nothing ever tried). The
  // point of this test isn't the exact status code, it's that this is a
  // *different* code than any of the guards above throw, proving they
  // aren't accidentally blocking a legitimate send too.
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, 'waba_not_connected');
});

test('7b. interactive send: schema rejects more than 3 buttons with a clear error, before ever reaching Meta', async () => {
  const contact = await createContact(`91909${Date.now()}`.slice(0, 12));
  const res = await fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: apiAuthed(apiKey),
    body: JSON.stringify({
      client_id: testClientId, to: contact.phone, type: 'interactive', body: 'Pick one',
      buttons: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }],
    }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(JSON.stringify(data), /at most 3 reply buttons/i);
});

// Must run before test 8 below, same reason test 7's own comment gives —
// test 8 pushes this client's usage over its plan limit for the rest of the
// file. Needs a connected WABA (fake token, never actually reaches Meta —
// metaClient.sendInteractiveMessage is stubbed below) and a contact with a
// recent inbound message, since the 24h session-window guard applies to
// 'interactive' sends exactly like 'text' (messagingService.js).
test('7c. interactive send reaches the real send function with the correctly-shaped Meta payload', async () => {
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: `${SUITE_PREFIX}waba`,
    phone_number_id: `${SUITE_PREFIX}phone`,
    status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });
  const phone = `91910${Date.now()}`.slice(0, 12);
  const contact = await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: 'Interactive Test Contact', wa_id: phone });
  const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
  await chatsRepo.insertInbound(pool, testClientId, chat.id, {
    metaMessageId: `wamid.apiv1_interactive_setup_${Date.now()}`, body: 'hi', sentAt: new Date().toISOString(),
  });

  // Stubs one level deeper than metaClient.sendInteractiveMessage itself
  // (global.fetch, same pattern templateSync.test.js's pagination test
  // uses) so the real, unmodified interactive-object-building logic in
  // metaClient.js actually runs — this captures the exact Graph API request
  // body that function constructs, not a hand-written approximation of it.
  const originalFetch = global.fetch;
  let capturedRequest = null;
  global.fetch = async (url, options) => {
    // Only Meta's Graph API is faked — the test's own call to this app's
    // local server (below) must still go through the real fetch, or it
    // would just hit this stub instead of ever reaching the route.
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    capturedRequest = { url: String(url), body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.FAKE_META_MESSAGE_ID_INTERACTIVE_TEST' }] }),
    };
  };

  let res, data;
  try {
    res = await fetch(`${baseUrl}/api/v1/messages`, {
      method: 'POST',
      headers: apiAuthed(apiKey),
      body: JSON.stringify({
        client_id: testClientId, to: phone, type: 'interactive',
        header: 'Quick question', body: 'Did you receive your order?', footer: 'Reply below',
        buttons: [{ id: 'order_yes', title: 'Yes' }, { id: 'order_no', title: 'No' }],
      }),
    });
    data = await res.json();
  } finally {
    global.fetch = originalFetch;
    // Undo the "connected" status set above — later tests in this file
    // (8's createTemplate call) rely on this shared client having NO
    // connected WABA; routes/templates.js submits to a real Meta call once
    // one exists, which fails against this test's fake token and broke
    // test 8's template creation when this cleanup was missing.
    await wabasRepo.upsertForClient(testClientId, { status: 'disconnected' });
  }

  assert.equal(res.status, 201, JSON.stringify(data));
  assert.equal(data.status, 'sent');
  assert.equal(data.meta_message_id, 'wamid.FAKE_META_MESSAGE_ID_INTERACTIVE_TEST');

  assert.ok(capturedRequest, 'the real metaClient.sendInteractiveMessage must actually have reached fetch()');
  assert.match(capturedRequest.url, /\/__test_suite__apiv1_phone\/messages$/);
  assert.deepEqual(capturedRequest.body, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Did you receive your order?' },
      action: { buttons: [
        { type: 'reply', reply: { id: 'order_yes', title: 'Yes' } },
        { type: 'reply', reply: { id: 'order_no', title: 'No' } },
      ] },
      header: { type: 'text', text: 'Quick question' },
      footer: { text: 'Reply below' },
    },
  });

  // Real captured evidence for the client's sample — logged, not asserted,
  // so it shows up in test output verbatim for handing off.
  console.log('REAL CAPTURED Graph API request body (Item 3 verification):', JSON.stringify(capturedRequest.body, null, 2));
  console.log('REAL CAPTURED Hub API response:', JSON.stringify(data, null, 2));
});

test('7d. list send: schema rejects more than 10 rows total across sections (6+6, no single section over 10)', async () => {
  const contact = await createContact(`91911${Date.now()}`.slice(0, 12));
  const res = await fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: apiAuthed(apiKey),
    body: JSON.stringify({
      client_id: testClientId, to: contact.phone, type: 'interactive',
      body: 'Choose a category', button: 'View Options',
      sections: [
        { title: 'Section A', rows: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, title: `Row A${i}` })) },
        { title: 'Section B', rows: Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, title: `Row B${i}` })) },
      ],
    }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(JSON.stringify(data), /10 rows total across all sections combined, not per section/i);
});

test('7e. a request setting both buttons and sections is rejected as an invalid mixed type', async () => {
  const contact = await createContact(`91912${Date.now()}`.slice(0, 12));
  const res = await fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: apiAuthed(apiKey),
    body: JSON.stringify({
      client_id: testClientId, to: contact.phone, type: 'interactive', body: 'Pick one',
      buttons: [{ id: 'yes', title: 'Yes' }],
      button: 'View Options',
      sections: [{ rows: [{ id: 'row1', title: 'Row 1' }] }],
    }),
  });
  assert.equal(res.status, 400);
});

// Must run before test 8 below, same reason 7c's own comment gives.
test('7f. list send reaches the real send function with the correctly-shaped Meta payload', async () => {
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: `${SUITE_PREFIX}waba`,
    phone_number_id: `${SUITE_PREFIX}phone`,
    status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });
  const phone = `91913${Date.now()}`.slice(0, 12);
  const contact = await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: 'List Test Contact', wa_id: phone });
  const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
  await chatsRepo.insertInbound(pool, testClientId, chat.id, {
    metaMessageId: `wamid.apiv1_list_setup_${Date.now()}`, body: 'hi', sentAt: new Date().toISOString(),
  });

  const originalFetch = global.fetch;
  let capturedRequest = null;
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    capturedRequest = { url: String(url), body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.FAKE_META_MESSAGE_ID_LIST_TEST' }] }),
    };
  };

  let res, data;
  try {
    res = await fetch(`${baseUrl}/api/v1/messages`, {
      method: 'POST',
      headers: apiAuthed(apiKey),
      body: JSON.stringify({
        client_id: testClientId, to: phone, type: 'interactive',
        header: 'Support Menu', body: 'What do you need help with?', footer: 'Powered by Wasi',
        button: 'View Options',
        sections: [
          {
            title: 'Orders',
            rows: [
              { id: 'track_order', title: 'Track my order', description: 'See delivery status' },
              { id: 'cancel_order', title: 'Cancel my order', description: 'Cancel within 24h of purchase' },
            ],
          },
          {
            title: 'Account',
            rows: [
              { id: 'reset_password', title: 'Reset password' },
            ],
          },
        ],
      }),
    });
    data = await res.json();
  } finally {
    global.fetch = originalFetch;
    // Same reset as 7c — later tests in this file rely on this shared
    // client having no connected WABA.
    await wabasRepo.upsertForClient(testClientId, { status: 'disconnected' });
  }

  assert.equal(res.status, 201, JSON.stringify(data));
  assert.equal(data.status, 'sent');
  assert.equal(data.meta_message_id, 'wamid.FAKE_META_MESSAGE_ID_LIST_TEST');

  assert.ok(capturedRequest, 'the real metaClient.sendListMessage must actually have reached fetch()');
  assert.deepEqual(capturedRequest.body, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: 'What do you need help with?' },
      action: {
        button: 'View Options',
        sections: [
          {
            title: 'Orders',
            rows: [
              { id: 'track_order', title: 'Track my order', description: 'See delivery status' },
              { id: 'cancel_order', title: 'Cancel my order', description: 'Cancel within 24h of purchase' },
            ],
          },
          {
            title: 'Account',
            rows: [{ id: 'reset_password', title: 'Reset password' }],
          },
        ],
      },
      header: { type: 'text', text: 'Support Menu' },
      footer: { text: 'Powered by Wasi' },
    },
  });

  console.log('REAL CAPTURED Graph API request body (Item 4 verification):', JSON.stringify(capturedRequest.body, null, 2));
  console.log('REAL CAPTURED Hub API response:', JSON.stringify(data, null, 2));
});

test('8. send reuses the plan-limit guard', async () => {
  const contact = await createContact(`91903${Date.now()}`.slice(0, 12));
  const template = await createTemplate('Utility'); // consent-exempt, isolates the plan-limit guard specifically

  await pool.query(
    `insert into subscriptions (client_id, plan, status) values ($1, 'Starter', 'active')`,
    [testClientId]
  );
  // Starter's conversation_limit is 500 (server/src/db/migrations/008_billing.js) — push usage past it directly.
  await pool.query(
    `insert into usage_logs (client_id, date, messages_sent) values ($1, current_date, 501)
     on conflict (client_id, date) do update set messages_sent = 501`,
    [testClientId]
  );

  const res = await fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: apiAuthed(apiKey),
    body: JSON.stringify({ client_id: testClientId, to: contact.phone, type: 'template', template: template.name }),
  });
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, 'plan_limit_reached');
});

test('9. template creation via the hub API reuses named-parameter validation', async () => {
  const res = await fetch(`${baseUrl}/api/v1/templates`, {
    method: 'POST',
    headers: apiAuthed(apiKey),
    body: JSON.stringify({ name: `${SUITE_PREFIX}bad_${Date.now()}`, category: 'Utility', body: 'Hello {{1}}, thanks!' }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.details.join(' '), /numbered parameters/i);
});
