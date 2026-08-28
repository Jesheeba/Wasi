// Unit tests per tool: correct Hub API request construction (method, path,
// query, body) and correct error-code-to-plain-English mapping — with
// global.fetch stubbed to a canned response, no network, no database. Runs
// as part of the default `npm test` (see package.json) — unlike
// test/integration.test.js, nothing here touches the real backend/DB.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { allTools } = require('../src/tools');

function toolByName(name) {
  const tool = allTools.find((t) => t.name === name);
  assert.ok(tool, `expected a registered tool named ${name}`);
  return tool;
}

async function callHandler(name, args) {
  return toolByName(name).handler(args, {});
}

let originalFetch;
let calls;
// path -> response (status, body) — matched by exact "METHOD path" key.
// GET /api/v1/account is pre-seeded on every test since hubClient.getClientId()
// caches its result for the whole process, and most tools call it first.
let responses;

before(() => {
  originalFetch = global.fetch;
  process.env.WASI_API_KEY = 'test-fake-key';
  process.env.WASI_API_BASE_URL = 'https://hub.test.invalid';
});

after(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  calls = [];
  responses = new Map([
    ['GET /api/v1/account', { status: 200, body: { client_id: 'client-abc-123', connected: false, status: 'not_connected' } }],
  ]);
  global.fetch = async (url, options) => {
    const u = new URL(url);
    const key = `${options.method} ${u.pathname}`;
    calls.push({ method: options.method, pathname: u.pathname, query: Object.fromEntries(u.searchParams), body: options.body ? JSON.parse(options.body) : undefined, url: String(url) });
    const canned = responses.get(key);
    if (!canned) throw new Error(`test stub: no canned response for ${key}`);
    return {
      ok: canned.status < 400,
      status: canned.status,
      text: async () => JSON.stringify(canned.body),
    };
  };
});

test('send_text_message: POSTs /api/v1/messages with client_id auto-resolved and type text', async () => {
  responses.set('POST /api/v1/messages', { status: 201, body: { id: 'm1', status: 'sent' } });
  const result = await callHandler('send_text_message', { to: '919876543210', body: 'hi' });
  assert.equal(result.isError, undefined);

  const send = calls.find((c) => c.method === 'POST' && c.pathname === '/api/v1/messages');
  assert.ok(send);
  assert.deepEqual(send.body, { client_id: 'client-abc-123', to: '919876543210', type: 'text', body: 'hi' });
});

test('send_template_message: forwards template name, named params, and header_media_url', async () => {
  responses.set('POST /api/v1/messages', { status: 201, body: { id: 'm2', status: 'sent' } });
  await callHandler('send_template_message', {
    to: '919876543210', template: 'order_confirmation', params: { customer_name: 'Asha' },
    header_media_url: 'https://example.com/invoice.pdf',
  });

  const send = calls.find((c) => c.method === 'POST' && c.pathname === '/api/v1/messages');
  assert.equal(send.body.type, 'template');
  assert.equal(send.body.template, 'order_confirmation');
  assert.deepEqual(send.body.params, { customer_name: 'Asha' });
  assert.equal(send.body.headerMediaUrl, 'https://example.com/invoice.pdf');
});

test('send_list_message: forwards button label and sections as-is', async () => {
  responses.set('POST /api/v1/messages', { status: 201, body: { id: 'm3', status: 'sent' } });
  await callHandler('send_list_message', {
    to: '919876543210', body: 'Choose', button: 'Open',
    sections: [{ title: 'Options', rows: [{ id: 'a', title: 'A' }] }],
  });

  const send = calls.find((c) => c.method === 'POST' && c.pathname === '/api/v1/messages');
  assert.equal(send.body.type, 'interactive');
  assert.equal(send.body.button, 'Open');
  assert.equal(send.body.sections.length, 1);
});

test('get_message_status: GETs /api/v1/messages/:id/status', async () => {
  responses.set('GET /api/v1/messages/msg-42/status', { status: 200, body: { id: 'msg-42', status: 'delivered' } });
  const result = await callHandler('get_message_status', { message_id: 'msg-42' });
  assert.equal(result.isError, undefined);
  const get = calls.find((c) => c.pathname === '/api/v1/messages/msg-42/status');
  assert.equal(get.method, 'GET');
});

test('list_templates: GETs /api/v1/templates with no query', async () => {
  responses.set('GET /api/v1/templates', { status: 200, body: [{ id: 't1', name: 'welcome' }] });
  await callHandler('list_templates', {});
  assert.ok(calls.some((c) => c.method === 'GET' && c.pathname === '/api/v1/templates'));
});

test('get_template_details: GETs /api/v1/templates/:id', async () => {
  responses.set('GET /api/v1/templates/t1', { status: 200, body: { id: 't1', name: 'welcome' } });
  await callHandler('get_template_details', { template_id: 't1' });
  assert.ok(calls.some((c) => c.pathname === '/api/v1/templates/t1'));
});

test('list_conversations: forwards limit as a query param, defaults to 20', async () => {
  responses.set('GET /api/v1/conversations', { status: 200, body: [] });
  await callHandler('list_conversations', { limit: 20 });
  const get = calls.find((c) => c.pathname === '/api/v1/conversations');
  assert.equal(get.query.limit, '20');
});

test('get_conversation_history: GETs /api/v1/conversations/:id/messages with limit', async () => {
  responses.set('GET /api/v1/conversations/chat-1/messages', { status: 200, body: [] });
  await callHandler('get_conversation_history', { chat_id: 'chat-1', limit: 50 });
  const get = calls.find((c) => c.pathname === '/api/v1/conversations/chat-1/messages');
  assert.equal(get.query.limit, '50');
});

test('search_contacts: passes q/phone through as query params, omitting whichever is unset', async () => {
  responses.set('GET /api/v1/contacts', { status: 200, body: [] });
  await callHandler('search_contacts', { query: 'zebra', limit: 20 });
  const get = calls.find((c) => c.pathname === '/api/v1/contacts');
  assert.equal(get.query.q, 'zebra');
  assert.equal('phone' in get.query, false);
});

test('get_account_status: GETs /api/v1/account', async () => {
  const result = await callHandler('get_account_status', {});
  assert.equal(result.isError, undefined);
  assert.ok(calls.some((c) => c.pathname === '/api/v1/account'));
});

test('get_rate_limit_status: GETs /api/v1/account/rate-limit', async () => {
  responses.set('GET /api/v1/account/rate-limit', { status: 200, body: { limit_per_minute: 300, window_seconds: 60 } });
  const result = await callHandler('get_rate_limit_status', {});
  assert.equal(result.isError, undefined);
  assert.ok(calls.some((c) => c.pathname === '/api/v1/account/rate-limit'));
});

// --- Error mapping (plan doc §7: structured, model-readable, not a raw HTTP dump) ---

test('a Hub API code with a known hint (session_window_closed) gets the plain-English next-step appended', async () => {
  responses.set('POST /api/v1/messages', {
    status: 409,
    body: { error: { code: 'session_window_closed', message: 'This chat is outside the 24-hour customer service window — send a template message instead.' } },
  });
  const result = await callHandler('send_text_message', { to: '919876543210', body: 'hi' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /session_window_closed/);
  assert.match(result.content[0].text, /send_template_message/i);
});

test('a Meta metaError code (131047) gets its own plain-English hint appended', async () => {
  responses.set('POST /api/v1/messages', {
    status: 502,
    body: { error: { code: 'send_failed', message: 'Meta rejected the send', metaError: { code: 131047, message: '(#131047) Re-engagement message' } } },
  });
  const result = await callHandler('send_text_message', { to: '919876543210', body: 'hi' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /24-hour customer service window/i);
});

test('a template that fails validation returns Hub API details verbatim, not a bare status code', async () => {
  responses.set('GET /api/v1/templates/bad-id', { status: 404, body: { error: { code: 'template_not_found', message: 'Not found.' } } });
  const result = await callHandler('get_template_details', { template_id: 'bad-id' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/i);
});

test('a network failure (Hub API unreachable) is reported as a structured error, not an unhandled rejection', async () => {
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const result = await callHandler('get_account_status', {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /could not reach/i);
});
