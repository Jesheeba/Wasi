// Consent/opt-in tracking (build plan Phase 4). Covers the seven scenarios
// from the original spec: marketing sends are blocked for anyone who isn't
// 'opted_in' (fail closed for unknown-category templates too), utility sends
// are unaffected, inbound STOP flips status, broadcasts skip non-opted-in
// recipients and report the count, and creation never bulk-marks anyone
// opted_in. Dedicated, disposable test client — see api.test.js's `before()`
// comment for why: this client never gets a real WABA, so nothing here can
// reach a real phone.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const broadcastRunner = require('../src/services/broadcastRunner');

let server;
let baseUrl;
let clientToken;
let testClientId;

const SUITE_PREFIX = '__test_suite__consent_';
const TEST_WABA_ID = 'test_suite_consent_waba_id';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function createContact(phone, name = 'Consent Test Contact', tagId) {
  return fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name, phone, tag_id: tagId || undefined }),
  }).then((r) => r.json());
}

async function createChat(contact) {
  return fetch(`${baseUrl}/api/chats`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: contact.name, phone: contact.phone, contact_id: contact.id }),
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

async function sendTemplate(chatId, templateName) {
  return fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ type: 'template', templateName, templateLanguage: 'en_US' }),
  });
}

async function setConsent(contactId, event, source = 'test_suite') {
  return fetch(`${baseUrl}/api/contacts/${contactId}/consent`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ event, source }),
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
      email: `test-suite-consent-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  // Needed only for the inbound-STOP test (webhook dispatch resolves the
  // client via wabas.waba_id) — never given a real access token, so it can
  // never actually send.
  await wabasRepo.upsertForClient(testClientId, { waba_id: TEST_WABA_ID, status: 'connected' });
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('1. marketing send to a contact whose status is unknown is blocked', async () => {
  const contact = await createContact(`91700${Date.now()}`.slice(0, 12));
  assert.equal(contact.opt_in_status, 'unknown');
  const chat = await createChat(contact);
  const template = await createTemplate('Marketing');

  const res = await sendTemplate(chat.id, template.name);
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, 'consent_required');
});

test('2. marketing send to an opted-out contact is blocked', async () => {
  const contact = await createContact(`91701${Date.now()}`.slice(0, 12));
  const chat = await createChat(contact);
  const template = await createTemplate('Marketing');

  await setConsent(contact.id, 'opted_in');
  await setConsent(contact.id, 'opted_out');

  const res = await sendTemplate(chat.id, template.name);
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, 'consent_required');
});

test('3. utility send to an unknown-status contact is allowed through the consent gate', async () => {
  const contact = await createContact(`91702${Date.now()}`.slice(0, 12));
  assert.equal(contact.opt_in_status, 'unknown');
  const chat = await createChat(contact);
  const template = await createTemplate('Utility');

  const res = await sendTemplate(chat.id, template.name);
  const data = await res.json();
  // Blocked further downstream by the test client having no connected WABA —
  // the point here is it is NOT blocked by the consent gate.
  assert.notEqual(data.code, 'consent_required');
  assert.equal(data.code, 'waba_not_connected');
});

test('4. a template name with no matching local template is treated as marketing (fail closed)', async () => {
  const contact = await createContact(`91703${Date.now()}`.slice(0, 12));
  const chat = await createChat(contact);

  const res = await sendTemplate(chat.id, `${SUITE_PREFIX}nonexistent_template_${Date.now()}`);
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, 'consent_required');
});

test('5. inbound STOP-keyword message flips the contact to opted_out and writes a consent_events row', async () => {
  const phone = `91704${Date.now()}`.slice(0, 12);
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: TEST_WABA_ID,
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '917339561631', phone_number_id: 'test_suite_consent_phone_id' },
          contacts: [{ wa_id: phone, profile: { name: 'Stop Sender' } }],
          messages: [{ from: phone, id: `wamid.stop_${Date.now()}`, type: 'text', text: { body: 'STOP' }, timestamp: '1786973208' }],
        },
      }],
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

  const { rows: contactRows } = await pool.query(
    'select * from contacts where client_id = $1 and phone = $2',
    [testClientId, phone]
  );
  assert.equal(contactRows.length, 1);
  assert.equal(contactRows[0].opt_in_status, 'opted_out');
  assert.ok(contactRows[0].opt_out_at);

  const { rows: eventRows } = await pool.query(
    'select * from consent_events where client_id = $1 and contact_id = $2 order by created_at desc',
    [testClientId, contactRows[0].id]
  );
  assert.equal(eventRows.length, 1);
  assert.equal(eventRows[0].event, 'opted_out');
  assert.equal(eventRows[0].source, 'inbound_stop_keyword');
});

test('6. broadcast skips non-opted-in recipients and reports the skipped count', async () => {
  // Scoped to a dedicated tag, not the client's whole audience — this test
  // file shares one client across all 7 tests, so an untagged (audience =
  // every contact) broadcast here would also sweep up contacts created by
  // the earlier scenarios.
  const tag = await fetch(`${baseUrl}/api/tags`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}tag_${Date.now()}`, bg: '#EEEEEE', color: '#111111' }),
  }).then((r) => r.json());

  const optedInContact = await createContact(`91705${Date.now()}`.slice(0, 12), 'Consent Test Contact', tag.id);
  await setConsent(optedInContact.id, 'opted_in');
  const unknownA = await createContact(`91706${Date.now()}`.slice(0, 12), 'Consent Test Contact', tag.id);
  const unknownB = await createContact(`91707${Date.now()}`.slice(0, 12), 'Consent Test Contact', tag.id);

  const template = await createTemplate('Marketing');
  const created = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ title: `${SUITE_PREFIX}broadcast_${Date.now()}`, templateName: template.name, tag_id: tag.id }),
  }).then((r) => r.json());

  assert.equal(created.recipient_count, 3);
  assert.ok(created.consentWarning, 'majority-unopted-in audience must surface a pre-send warning');

  // broadcastRunner normally picks this up on its 5s tick (started only from
  // server/src/index.js, not from createApp()/this test process) — invoked
  // directly here, scoped to only this one broadcast, rather than calling
  // tick()/listActive() which would reach across every client's broadcasts
  // in the shared dev database.
  await broadcastRunner.processBroadcast(created);

  const { rows: recipientRows } = await pool.query(
    `select br.status, br.error_reason, c.phone
     from broadcast_recipients br
     join contacts c on c.id = br.contact_id
     where br.broadcast_id = $1`,
    [created.id]
  );
  const byPhone = Object.fromEntries(recipientRows.map((r) => [r.phone, r]));
  assert.equal(byPhone[unknownA.phone].status, 'skipped');
  assert.match(byPhone[unknownA.phone].error_reason, /not opted in/i);
  assert.equal(byPhone[unknownB.phone].status, 'skipped');
  // Opted-in recipient is attempted (not skipped for consent) — it fails for
  // an unrelated reason (no connected WABA on this test client).
  assert.equal(byPhone[optedInContact.phone].status, 'failed');

  const [listed] = await fetch(`${baseUrl}/api/broadcasts`, { headers: authed(clientToken) })
    .then((r) => r.json())
    .then((list) => list.filter((b) => b.id === created.id));
  assert.equal(listed.skipped_consent_count, 2);
});

test('7. creating a contact never defaults opt_in_status to opted_in', async () => {
  const contact = await createContact(`91708${Date.now()}`.slice(0, 12));
  assert.equal(contact.opt_in_status, 'unknown');
  assert.equal(contact.opt_in_source, null);
  assert.equal(contact.opt_in_at, null);
});
