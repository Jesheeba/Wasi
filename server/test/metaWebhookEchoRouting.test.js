// Router-level regression test for echo/inbound dispatch in routes/metaWebhook.js.
//
// Why this exists: coexistenceEchoIngestion.test.js calls handleMessageEchoes
// directly, so by construction it cannot catch a mistake in the ROUTER's
// dispatch — which is where this bug lived. POST / used to run
// handleInboundMessages for ANY change whose value.messages array was
// non-empty, with no look at the field name. If an echo ever arrived as
// `field: "smb_message_echoes"` with its array under `messages` (one of the
// shapes the echo handler tolerates), BOTH handlers ran: the business's own
// outgoing message was ingested as an INBOUND customer message — a contact
// created for the business's own number, the flow engine and keyword
// automation run on it, and a message.received forward enqueued.
//
// Every request here goes through the real Express app and the real router
// with a validly signed body. Stubs only, nothing reaches a database: repo
// functions and pool.query are monkey-patched on their required singleton
// module objects and restored after each test (same pattern as
// coexistenceEchoIngestion.test.js).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const usageRepo = require('../src/repositories/usageRepo');
const auditLogRepo = require('../src/repositories/auditLogRepo');
const clientWebhooksRepo = require('../src/repositories/clientWebhooksRepo');
const zapierSubscriptionsRepo = require('../src/repositories/zapierSubscriptionsRepo');
const flowEngine = require('../src/services/flowEngine');

const TEST_APP_SECRET = 'test-suite-echo-routing-app-secret';
const WABA_ROW = { id: 'waba-row-echo', client_id: 'client-echo', waba_id: 'echo-routing-waba', forward_to_url: null, forward_events: [] };
const BUSINESS_NUMBER = '911234500000';
const CUSTOMER_NUMBER = '919876500000';

let server;
let baseUrl;
let savedSecret;
let originals;
let calls;

before(async () => {
  savedSecret = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = TEST_APP_SECRET;
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (savedSecret === undefined) delete process.env.META_APP_SECRET;
  else process.env.META_APP_SECRET = savedSecret;
  // Nothing here ever opened a real connection (pool.query is stubbed), but
  // ending an unused pg Pool is harmless and keeps the process from lingering.
  await pool.end().catch(() => {});
});

beforeEach(() => {
  calls = { upsertByPhone: [], insertInbound: [], insertEcho: [], flowEvaluate: [], incrementReceived: 0, poolQuery: 0 };
  originals = {
    findByWabaId: wabasRepo.findByWabaId,
    upsertByPhone: contactsRepo.upsertByPhone,
    findOrCreateByContact: chatsRepo.findOrCreateByContact,
    insertInbound: chatsRepo.insertInbound,
    insertEcho: chatsRepo.insertEcho,
    incrementReceived: usageRepo.incrementReceived,
    record: auditLogRepo.record,
    findByClientId: clientWebhooksRepo.findByClientId,
    listByClientAndEvent: zapierSubscriptionsRepo.listByClientAndEvent,
    evaluate: flowEngine.evaluate,
    poolQuery: pool.query,
  };

  wabasRepo.findByWabaId = async () => WABA_ROW;
  contactsRepo.upsertByPhone = async (db, clientId, { phone, name }) => {
    calls.upsertByPhone.push({ clientId, phone, name });
    return { id: `contact-${phone}`, client_id: clientId, phone, name };
  };
  chatsRepo.findOrCreateByContact = async (db, clientId, contact) => ({ id: `chat-${contact.phone}`, client_id: clientId, contact_id: contact.id });
  chatsRepo.insertInbound = async (db, clientId, chatId, fields) => {
    calls.insertInbound.push({ chatId, fields });
    return { id: 'message-in', chat_id: chatId, client_id: clientId, direction: 'in', status: 'delivered', meta_message_id: fields.metaMessageId, body: fields.body, sent_at: new Date().toISOString() };
  };
  chatsRepo.insertEcho = async (db, clientId, chatId, fields) => {
    calls.insertEcho.push({ chatId, fields });
    return { id: 'message-echo', chat_id: chatId, client_id: clientId, direction: 'out', ...fields };
  };
  usageRepo.incrementReceived = async () => { calls.incrementReceived += 1; };
  auditLogRepo.record = async () => {};
  clientWebhooksRepo.findByClientId = async () => null;
  zapierSubscriptionsRepo.listByClientAndEvent = async () => [];
  flowEngine.evaluate = async (db, clientId, contact, chat, msg, body) => { calls.flowEvaluate.push({ contactPhone: contact.phone, body }); };
  // The router persists one meta_webhook_log row per delivery via pool.query.
  pool.query = async () => { calls.poolQuery += 1; return { rows: [], rowCount: 0 }; };
});

afterEach(() => {
  wabasRepo.findByWabaId = originals.findByWabaId;
  contactsRepo.upsertByPhone = originals.upsertByPhone;
  chatsRepo.findOrCreateByContact = originals.findOrCreateByContact;
  chatsRepo.insertInbound = originals.insertInbound;
  chatsRepo.insertEcho = originals.insertEcho;
  usageRepo.incrementReceived = originals.incrementReceived;
  auditLogRepo.record = originals.record;
  clientWebhooksRepo.findByClientId = originals.findByClientId;
  zapierSubscriptionsRepo.listByClientAndEvent = originals.listByClientAndEvent;
  flowEngine.evaluate = originals.evaluate;
  pool.query = originals.poolQuery;
});

async function postChange(field, value) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: WABA_ROW.waba_id, changes: [{ field, value: { messaging_product: 'whatsapp', ...value } }] }],
  });
  const signature = `sha256=${crypto.createHmac('sha256', TEST_APP_SECRET).update(body).digest('hex')}`;
  const res = await fetch(`${baseUrl}/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
  return res.status;
}

test('router: field smb_message_echoes with the array under `messages` is ingested as an echo ONLY — never as an inbound message', async () => {
  const status = await postChange('smb_message_echoes', {
    messages: [{ id: 'wamid.ECHO_UNDER_MESSAGES', from: BUSINESS_NUMBER, to: CUSTOMER_NUMBER, timestamp: '1758700000', type: 'text', text: { body: 'Sent from my phone' } }],
  });
  assert.equal(status, 200);
  assert.equal(calls.insertInbound.length, 0, 'handleInboundMessages must not run for an echo field');
  assert.equal(calls.flowEvaluate.length, 0, 'the flow engine / keyword automation must never fire on an echo');
  assert.equal(calls.incrementReceived, 0, 'an echo is not a received message');
  assert.equal(calls.insertEcho.length, 1, 'the echo handler must still ingest it');
  assert.deepEqual(calls.upsertByPhone.map((c) => c.phone), [CUSTOMER_NUMBER], 'the only contact touched is the CUSTOMER (`to`), never the business\'s own number (`from`)');
});

test('router: field smb_message_echoes with the documented `message_echoes` array is ingested as an echo only', async () => {
  const status = await postChange('smb_message_echoes', {
    message_echoes: [{ id: 'wamid.ECHO_DOCUMENTED', from: BUSINESS_NUMBER, to: CUSTOMER_NUMBER, timestamp: '1758700100', type: 'text', text: { body: 'Hello' } }],
  });
  assert.equal(status, 200);
  assert.equal(calls.insertEcho.length, 1);
  assert.equal(calls.insertInbound.length, 0);
  assert.equal(calls.flowEvaluate.length, 0);
});

test('router: an echo array arriving under field `messages` (existing behaviour) is still an echo only', async () => {
  const status = await postChange('messages', {
    message_echoes: [{ id: 'wamid.ECHO_UNDER_MESSAGES_FIELD', from: BUSINESS_NUMBER, to: CUSTOMER_NUMBER, timestamp: '1758700200', type: 'text', text: { body: 'Hi' } }],
  });
  assert.equal(status, 200);
  assert.equal(calls.insertEcho.length, 1);
  assert.equal(calls.insertInbound.length, 0);
  assert.equal(calls.flowEvaluate.length, 0);
});

test('router: an ordinary inbound customer message under field `messages` still runs the inbound path and NOT the echo path (the guard must not break inbound)', async () => {
  const status = await postChange('messages', {
    contacts: [{ profile: { name: 'Customer' }, wa_id: CUSTOMER_NUMBER }],
    messages: [{ id: 'wamid.REAL_INBOUND', from: CUSTOMER_NUMBER, timestamp: '1758700300', type: 'text', text: { body: 'What are the fees?' } }],
  });
  assert.equal(status, 200);
  assert.equal(calls.insertInbound.length, 1);
  assert.equal(calls.flowEvaluate.length, 1);
  assert.equal(calls.flowEvaluate[0].body, 'What are the fees?');
  assert.equal(calls.incrementReceived, 1);
  assert.equal(calls.insertEcho.length, 0);
  assert.deepEqual(calls.upsertByPhone.map((c) => c.phone), [CUSTOMER_NUMBER]);
});
