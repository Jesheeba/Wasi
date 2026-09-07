// Real production bug, fixed in two more places after apiV1Messages.js
// (server/test/apiV1MessageLanguage.test.js already covers that one):
// broadcastRunner.js's sendOneRecipient and flowEngine.js's
// executeSendTemplate both hardcoded templateLanguage: 'en_US' (flowEngine
// via a node.config.templateLanguage fallback no flow-builder UI has ever
// actually populated, confirmed by reading both editors' Send Template node
// config builders — so the fallback fired unconditionally in every real
// flow). A read-only production check (during this same fix) found the
// exact resulting failure — Meta error 132001, "Template name does not
// exist in the translation" — already recorded against a real client
// (Wasi Demo Client, 13 occurrences, not broadcast-attributed).
//
// broadcastRunner.js: real DB + real HTTP server + stubbed Meta fetch,
// same established pattern as broadcastSmartSending.test.js/
// broadcastPauseResume.test.js (processBroadcast's claimBatch does a real
// DB transaction, so this can't be pure-stubbed the way flowEngine's test
// below is).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const broadcastsRepo = require('../src/repositories/broadcastsRepo');
const broadcastRunner = require('../src/services/broadcastRunner');
const { encrypt } = require('../src/utils/encryption');

let server, baseUrl, clientToken, testClientId;

const SUITE_PREFIX = '__test_suite__tpllangfix_';
const PASSWORD = 'test-suite-password-12345';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function stub(obj, name, impl) {
  const original = obj[name];
  obj[name] = impl;
  return () => { obj[name] = original; };
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
      email: `test-suite-tpllangfix-${Date.now()}@wasi.local`,
      password: PASSWORD,
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  await wabasRepo.upsertForClient(testClientId, {
    waba_id: `${SUITE_PREFIX}waba`,
    phone_number_id: `${SUITE_PREFIX}phone`,
    status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('broadcastRunner.js: a broadcast against a non-en_US template sends to Meta with the REAL language, not a hardcoded en_US', async () => {
  const originalFetch = global.fetch;
  let capturedRequest = null;
  global.fetch = async (url, opts) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, opts);
    if (String(url).endsWith('/messages')) {
      capturedRequest = { url: String(url), body: JSON.parse(opts.body) };
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${SUITE_PREFIX}sent` }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_tpl`, status: 'APPROVED', category: 'UTILITY' }) };
  };

  let broadcast;
  try {
    const templateName = `${SUITE_PREFIX}tpl_${Date.now()}`;
    const templateRes = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST', headers: authed(clientToken),
      body: JSON.stringify({
        name: templateName, category: 'Utility', language: 'en',
        body: 'Hi {{customer_name}}, a real non-en_US broadcast language test message.',
        bodyParamExamples: { customer_name: 'Test' },
      }),
    });
    assert.equal(templateRes.status, 201, JSON.stringify(await templateRes.clone().json()));

    const ts = String(Date.now()).slice(-9);
    const tag = await fetch(`${baseUrl}/api/tags`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name: `${SUITE_PREFIX}tag_${ts}` }) }).then((r) => r.json());
    await fetch(`${baseUrl}/api/contacts`, { method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name: `${SUITE_PREFIX}C`, phone: `919${ts}`, tag_id: tag.id }) });

    broadcast = await fetch(`${baseUrl}/api/broadcasts`, {
      method: 'POST', headers: authed(clientToken),
      body: JSON.stringify({
        title: `${SUITE_PREFIX}camp`, tag_id: tag.id, templateName,
        paramMappings: { customer_name: { source: 'contact_field', field: 'name' } },
      }),
    }).then((r) => r.json());
    assert.equal(broadcast.recipient_count, 1);

    await broadcastRunner.processBroadcast(await broadcastsRepo.findById(pool, testClientId, broadcast.id));
  } finally {
    global.fetch = originalFetch;
  }

  assert.ok(capturedRequest, 'the real Meta send must actually have been attempted');
  assert.equal(capturedRequest.body.template.language.code, 'en', 'the REAL approved language must be sent, not a hardcoded en_US');

  const recipient = await pool.query('select status from broadcast_recipients where broadcast_id = $1', [broadcast.id]);
  assert.equal(recipient.rows[0].status, 'sent');
});

test('broadcastRunner.js: a recipient whose template has no local record fails cleanly (does not guess a language and attempt a doomed send)', async () => {
  const contact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Orphan`, phone: `9190${String(Date.now()).slice(-8)}` }),
  }).then((r) => r.json());

  const broadcast = await pool.query(
    `insert into broadcasts (client_id, title, template_name, status, param_mappings) values ($1, $2, $3, 'Sending', '{}') returning id`,
    [testClientId, `${SUITE_PREFIX}orphan_camp`, `${SUITE_PREFIX}does_not_exist_locally`]
  ).then((r) => r.rows[0]);
  await pool.query(
    `insert into broadcast_recipients (broadcast_id, client_id, contact_id, status) values ($1, $2, $3, 'pending')`,
    [broadcast.id, testClientId, contact.id]
  );

  const originalFetch = global.fetch;
  let metaWasCalled = false;
  global.fetch = async (url, opts) => {
    if (String(url).includes('graph.facebook.com')) metaWasCalled = true;
    return originalFetch(url, opts);
  };
  try {
    await broadcastRunner.processBroadcast(await broadcastsRepo.findById(pool, testClientId, broadcast.id));
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(metaWasCalled, false, 'must never attempt a send when the real language cannot be determined');
  const recipient = await pool.query('select status, error_reason from broadcast_recipients where broadcast_id = $1', [broadcast.id]);
  assert.equal(recipient.rows[0].status, 'failed');
  assert.match(recipient.rows[0].error_reason, /cannot determine its real approved language/i);
});

// flowEngine.js: pure-stub style, same pattern as flowEngineRunToRest.test.js
// (repos fully stubbed, no real DB) — startFlow with a send_template entry
// node is the thinnest real path into executeSendTemplate, which isn't
// exported directly.
test('flowEngine.js: executeSendTemplate (via startFlow) sends with the template\'s REAL language, ignoring node.config.templateLanguage entirely', async () => {
  const flowNodesRepo = require('../src/repositories/flowNodesRepo');
  const flowEventsRepo = require('../src/repositories/flowEventsRepo');
  const flowEdgesRepo = require('../src/repositories/flowEdgesRepo');
  const contactFlowStateRepo = require('../src/repositories/contactFlowStateRepo');
  const messageTemplatesRepo = require('../src/repositories/messageTemplatesRepo');
  const chatsRepo = require('../src/repositories/chatsRepo');
  const messagingService = require('../src/services/messagingService');
  const flowEngine = require('../src/services/flowEngine');

  const NODE = {
    id: 'node-send-template', type: 'send_template',
    config: {
      templateName: 'a_template',
      paramMappings: {},
      // Deliberately wrong/stale, proving the fix no longer trusts this
      // field at all — it's set here to something that would fail loudly
      // if it were ever actually used.
      templateLanguage: 'fr',
    },
  };
  let capturedSendArgs = null;
  const restores = [
    stub(flowNodesRepo, 'findById', async () => NODE),
    stub(flowEdgesRepo, 'listForNode', async () => []), // no outgoing edge -> implicit end, right after this one node executes
    stub(flowEventsRepo, 'record', async () => {}),
    stub(contactFlowStateRepo, 'create', async () => ({ version: 0 })),
    stub(contactFlowStateRepo, 'advance', async () => ({ id: 'x' })),
    stub(messageTemplatesRepo, 'findByNameAndClient', async () => ({ id: 'tpl-1', name: 'a_template', language: 'en', body: 'hi' })),
    stub(chatsRepo, 'findOrCreateByContact', async () => ({ id: 'chat-1' })),
    stub(messagingService, 'sendChatMessage', async (db, clientId, chat, args) => { capturedSendArgs = args; return { id: 'msg-1' }; }),
  ];

  try {
    const flow = { id: 'flow-1', entry_node_id: NODE.id };
    await flowEngine.startFlow({}, 'client-1', { id: 'contact-1' }, { id: 'chat-1' }, flow);
  } finally {
    restores.forEach((r) => r());
  }

  assert.ok(capturedSendArgs, 'sendChatMessage must actually have been called');
  assert.equal(capturedSendArgs.templateLanguage, 'en', 'must use the template record\'s real language, not node.config.templateLanguage');
});

test('flowEngine.js: a send_template node whose template has no local record throws a clear error (stalls cleanly), never sends with a guessed language', async () => {
  const flowNodesRepo = require('../src/repositories/flowNodesRepo');
  const flowEventsRepo = require('../src/repositories/flowEventsRepo');
  const contactFlowStateRepo = require('../src/repositories/contactFlowStateRepo');
  const messageTemplatesRepo = require('../src/repositories/messageTemplatesRepo');
  const messagingService = require('../src/services/messagingService');
  const flowEngine = require('../src/services/flowEngine');

  const NODE = { id: 'node-send-template-2', type: 'send_template', config: { templateName: 'missing_template', paramMappings: {} } };
  let sendWasCalled = false;
  let advanceCall = null;
  const restores = [
    stub(flowNodesRepo, 'findById', async () => NODE),
    stub(flowEventsRepo, 'record', async () => {}),
    stub(contactFlowStateRepo, 'create', async () => ({ version: 0 })),
    stub(contactFlowStateRepo, 'advance', async (db, args) => { advanceCall = args; return { id: 'x' }; }),
    stub(messageTemplatesRepo, 'findByNameAndClient', async () => null),
    stub(messagingService, 'sendChatMessage', async () => { sendWasCalled = true; return { id: 'x' }; }),
  ];

  try {
    const flow = { id: 'flow-1', entry_node_id: NODE.id };
    await assert.doesNotReject(() => flowEngine.startFlow({}, 'client-1', { id: 'contact-1' }, { id: 'chat-1' }, flow));
  } finally {
    restores.forEach((r) => r());
  }

  assert.equal(sendWasCalled, false, 'must never attempt a send when the real language cannot be determined');
  assert.equal(advanceCall.status, 'stalled');
});
