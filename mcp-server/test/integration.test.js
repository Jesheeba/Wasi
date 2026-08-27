// Real end-to-end integration: an actual McpServer (this package's real
// tool set) driving actual HTTP calls into the REAL Wasi backend
// (server/src/app.js's createApp(), the same Express app production runs),
// backed by the real (shared dev/prod) Postgres database — same pattern and
// same safety rail as server/test/apiV1.test.js: a dedicated, disposable
// test client (never the demo one), deleted in after(). ONLY the outbound
// call to graph.facebook.com is faked (global.fetch stub) — every other hop
// (MCP protocol -> hubClient fetch -> Express route -> repo -> Postgres) is
// the real, unmodified code path. No real WhatsApp message is ever sent.
//
// Requires ALLOW_SHARED_PRODUCTION_DB=yes-i-understand-the-risk for this one
// invocation (see server/src/utils/dbSafety.js) — there is no separate dev
// database for this project. Run explicitly, not part of the default `npm
// test` in this package (see package.json) so a plain `npm test` here never
// touches the shared database by accident.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'server', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createApp } = require(path.join(__dirname, '..', '..', 'server', 'src', 'app'));
const { pool } = require(path.join(__dirname, '..', '..', 'server', 'src', 'db', 'pool'));
const wabasRepo = require(path.join(__dirname, '..', '..', 'server', 'src', 'repositories', 'wabasRepo'));
const contactsRepo = require(path.join(__dirname, '..', '..', 'server', 'src', 'repositories', 'contactsRepo'));
const chatsRepo = require(path.join(__dirname, '..', '..', 'server', 'src', 'repositories', 'chatsRepo'));
const { encrypt } = require(path.join(__dirname, '..', '..', 'server', 'src', 'utils', 'encryption'));

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createServer } = require('../src/index');

const SUITE_PREFIX = '__test_suite__mcpintegration_';

let backendServer;
let backendBaseUrl;
let clientToken;
let testClientId;
let mcpClient;

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function callTool(name, args) {
  const result = await mcpClient.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, `${name} unexpectedly errored: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
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
      email: `test-suite-mcpintegration-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  const adminLogin = await fetch(`${backendBaseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: 'admin12345' }),
  }).then((r) => r.json());
  assert.ok(adminLogin.token, 'demo admin login must succeed — run `npm run db:seed` first');

  const issued = await fetch(`${backendBaseUrl}/api/admin/api-keys`, {
    method: 'POST',
    headers: authed(adminLogin.token),
    body: JSON.stringify({ client_id: testClientId, app_name: `${SUITE_PREFIX}app` }),
  }).then((r) => r.json());
  assert.ok(issued.key, 'api key creation via the admin route must succeed');

  // Point the MCP server's hubClient at this real, locally-running backend
  // instance, authenticated as the disposable test client.
  process.env.WASI_API_KEY = issued.key;
  process.env.WASI_API_BASE_URL = backendBaseUrl;

  const mcpServer = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client({ name: 'integration-test-client', version: '0.0.0' });
  await Promise.all([
    mcpClient.connect(clientTransport),
    mcpServer.connect(serverTransport),
  ]);
});

after(async () => {
  if (mcpClient) await mcpClient.close();
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => backendServer.close(resolve));
  await pool.end();
});

test('get_account_status: real round trip, resolves client_id with no WABA connected', async () => {
  const status = await callTool('get_account_status', {});
  assert.equal(status.connected, false);
  assert.equal(status.client_id, testClientId);
});

test('get_rate_limit_status: real round trip, static ceiling', async () => {
  const rateLimit = await callTool('get_rate_limit_status', {});
  assert.equal(rateLimit.limit_per_minute, 300);
});

test('send_text_message: real round trip surfaces the session-window guard as a clear, structured error', async () => {
  const phone = `91970${Date.now()}`.slice(0, 12);
  await fetch(`${backendBaseUrl}/api/contacts`, {
    method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name: 'MCP Test Contact', phone }),
  });

  const result = await mcpClient.callTool({ name: 'send_text_message', arguments: { to: phone, body: 'hello' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /24-hour customer service window/i);
  assert.match(result.content[0].text, /send_template_message/i);
});

test('list_templates + get_template_details: real round trip through the actual repo/DB', async () => {
  const created = await fetch(`${backendBaseUrl}/api/templates`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      name: `${SUITE_PREFIX}tpl_${Date.now()}`, category: 'Utility',
      body: 'Hi {{customer_name}}, thanks for your order!', bodyParamExamples: { customer_name: 'Riyaz' },
    }),
  }).then((r) => r.json());

  const templates = await callTool('list_templates', {});
  assert.ok(templates.some((t) => t.id === created.id));

  const details = await callTool('get_template_details', { template_id: created.id });
  assert.equal(details.body, 'Hi {{customer_name}}, thanks for your order!');
});

test('list_conversations, get_conversation_history, search_contacts: real round trip', async () => {
  const phone = `91971${Date.now()}`.slice(0, 12);
  const contact = await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: 'MCP Chat Contact' });
  const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
  await chatsRepo.insertInbound(pool, testClientId, chat.id, {
    metaMessageId: `wamid.mcp_integration_${Date.now()}`, body: 'hi there', sentAt: new Date().toISOString(),
  });

  const conversations = await callTool('list_conversations', { limit: 50 });
  assert.ok(conversations.some((c) => c.id === chat.id));

  const history = await callTool('get_conversation_history', { chat_id: chat.id, limit: 10 });
  assert.ok(history.some((m) => m.body === 'hi there'));

  const found = await callTool('search_contacts', { phone });
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'MCP Chat Contact');
});

// The deep proof: a real MCP tool call flows through hubClient's fetch,
// into the real Express route, through the real messagingService and
// metaClient.sendInteractiveMessage, and produces the exact Graph API
// request body Meta would receive — with ONLY graph.facebook.com faked.
test('send_button_message: real round trip captures the exact Graph API payload metaClient builds', async () => {
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: `${SUITE_PREFIX}waba`, phone_number_id: `${SUITE_PREFIX}phone`,
    status: 'connected', access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });
  const phone = `91972${Date.now()}`.slice(0, 12);
  const contact = await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: 'MCP Button Contact', wa_id: phone });
  const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
  await chatsRepo.insertInbound(pool, testClientId, chat.id, {
    metaMessageId: `wamid.mcp_integration_button_${Date.now()}`, body: 'hi', sentAt: new Date().toISOString(),
  });

  const originalFetch = global.fetch;
  let capturedRequest = null;
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    capturedRequest = { url: String(url), body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.MCP_INTEGRATION_FAKE_ID' }] }) };
  };

  let message;
  try {
    message = await callTool('send_button_message', {
      to: phone, body: 'Did you receive your order?', header: 'Quick question', footer: 'Reply below',
      buttons: [{ id: 'order_yes', title: 'Yes' }, { id: 'order_no', title: 'No' }],
    });
  } finally {
    global.fetch = originalFetch;
    await wabasRepo.upsertForClient(testClientId, { status: 'disconnected' });
  }

  assert.equal(message.status, 'sent');
  assert.equal(message.meta_message_id, 'wamid.MCP_INTEGRATION_FAKE_ID');
  assert.ok(capturedRequest, 'metaClient.sendInteractiveMessage must actually have reached fetch()');
  assert.deepEqual(capturedRequest.body.interactive, {
    type: 'button',
    body: { text: 'Did you receive your order?' },
    action: { buttons: [
      { type: 'reply', reply: { id: 'order_yes', title: 'Yes' } },
      { type: 'reply', reply: { id: 'order_no', title: 'No' } },
    ] },
    header: { type: 'text', text: 'Quick question' },
    footer: { text: 'Reply below' },
  });

  const status = await callTool('get_message_status', { message_id: message.id });
  assert.equal(status.status, 'sent');
  assert.equal(status.meta_message_id, 'wamid.MCP_INTEGRATION_FAKE_ID');

  console.log('REAL CAPTURED Graph API request body (via MCP tool call):', JSON.stringify(capturedRequest.body, null, 2));
  console.log('REAL MCP tool result (send_button_message):', JSON.stringify(message, null, 2));
});
