// Regression test for a real dispatch bug found during Phase 2 live
// verification: Meta sends BOTH new inbound messages and delivery status
// updates under field: "messages" — field name alone can't distinguish them.
// The old dispatch logic (`if field === 'messages' ... else if field ===
// 'statuses'`) silently dropped every status-only delivery, since Meta never
// actually sends field: "statuses" in practice. The fixture below is the
// exact PAYLOAD SHAPE captured live (via ngrok's request inspector) for a
// real send that failed with error 131047 (24h re-engagement window
// closed) — with the waba_id/phone_number_id swapped for fake, dedicated
// test values (what's being tested is dispatch logic, not the specific real
// WABA), tied to a disposable test client rather than the demo client that
// Phase 2 live verification uses.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const chatsRepo = require('../src/repositories/chatsRepo');

let server;
let baseUrl;
let testClientId;
let testMessageId;

// Clearly fake, dedicated to this test file — not the real WABA (983390651411856)
// Phase 2 is verifying against. wabas.waba_id is UNIQUE across the whole table,
// so this also can't collide with the real one even if both existed at once.
const TEST_WABA_ID = 'test_suite_dispatch_waba_id';
const TEST_META_MESSAGE_ID = 'wamid.test_suite_dispatch_fixture_message_id';

const REAL_STATUS_ONLY_PAYLOAD_SHAPE = {
  object: 'whatsapp_business_account',
  entry: [{
    id: TEST_WABA_ID,
    changes: [{
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '917339561631', phone_number_id: 'test_suite_dispatch_phone_id' },
        contacts: [{ wa_id: '919092766740', user_id: 'IN.1003571785622821' }],
        statuses: [{
          id: TEST_META_MESSAGE_ID,
          status: 'failed',
          timestamp: '1786973208',
          recipient_id: '919092766740',
          recipient_user_id: 'IN.1003571785622821',
          errors: [{
            code: 131047,
            title: 'Re-engagement message',
            message: 'Re-engagement message',
            error_data: {
              details: 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.',
            },
            href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/',
          }],
        }],
      },
      field: 'messages', // NOT "statuses" — this is the whole point of the fixture
    }],
  }],
};

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: '__test_suite__webhook_dispatch_client',
      email: `test-suite-webhook-dispatch-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  testClientId = registered.client?.id;
  assert.ok(testClientId, 'dedicated test client registration must succeed');

  // A WABA row matching the fixture's entry.id must exist for
  // wabasRepo.findByWabaId to resolve during dispatch.
  await wabasRepo.upsertForClient(testClientId, {
    waba_id: TEST_WABA_ID,
    status: 'connected',
  });

  // Seed a message row as if it had actually been sent, so
  // updateStatusByMetaId has a real row to flip — otherwise the assertion
  // below would pass even if dispatch were still broken (0 rows updated
  // looks the same as "nothing to update").
  const chat = await chatsRepo.create(pool, testClientId, {
    name: '__test_suite__ webhook dispatch fixture',
    phone: '919092766740',
    unread_count: 0,
  });
  const pending = await chatsRepo.insertOutboundPending(pool, testClientId, chat.id, 'test outbound');
  const sent = await chatsRepo.markSent(pool, testClientId, pending.id, TEST_META_MESSAGE_ID);
  testMessageId = sent.id;
});

after(async () => {
  // Cascade-deletes the wabas row, chat, and message this test created —
  // dedicated client, so nothing to snapshot/restore.
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('field "messages" carrying only a statuses array is dispatched, not silently dropped', async () => {
  const body = JSON.stringify(REAL_STATUS_ONLY_PAYLOAD_SHAPE);
  const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');

  const res = await fetch(`${baseUrl}/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
  assert.equal(res.status, 200);

  const { rows } = await pool.query('select status, error_reason from messages where id = $1', [testMessageId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  assert.match(rows[0].error_reason, /Re-engagement message/);
});

test('an actually-unhandled field does not silently 200 without a trace', async () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: TEST_WABA_ID,
      changes: [{ value: { some_future_field: 'unrecognized shape' }, field: 'some_totally_new_field_meta_invents' }],
    }],
  };
  const body = JSON.stringify(payload);
  const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');

  const res = await fetch(`${baseUrl}/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
  // Still 200 — Meta shouldn't get retried into a storm over an unknown
  // field — but it must show up in the audit log so it's not silently lost.
  assert.equal(res.status, 200);

  const { rows } = await pool.query(
    `select * from audit_log where actor_type = 'meta_webhook' and action = $1 order by created_at desc limit 1`,
    ['some_totally_new_field_meta_invents']
  );
  assert.equal(rows.length, 1);
});

test('a payload with two changes, one of which fails to write, persists the successful one and returns non-200', async () => {
  // Same failure shape that caused the Sirah CRM incident referenced in
  // wasi-build-plan.md: a write fails, the error gets caught (correctly —
  // one bad change shouldn't abort the others), but the response must NOT
  // silently claim success, or Meta never retries and the failed change is
  // gone after its 7-day window. The "bad" change here has no `from` on its
  // message, so contactsRepo.upsertByPhone hits contacts.phone's real
  // NOT NULL constraint — a genuine DB write failure, not a contrived
  // JS-level error.
  const goodPhone = `919${Date.now()}`.slice(0, 12);
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: TEST_WABA_ID,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '917339561631', phone_number_id: 'test_suite_dispatch_phone_id' },
            contacts: [{ wa_id: goodPhone, profile: { name: 'Good Contact' } }],
            messages: [{ from: goodPhone, id: `wamid.good_${Date.now()}`, type: 'text', text: { body: 'This should persist' }, timestamp: '1786973208' }],
          },
        },
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '917339561631', phone_number_id: 'test_suite_dispatch_phone_id' },
            contacts: [{ profile: { name: 'Bad Contact' } }], // no wa_id
            messages: [{ id: `wamid.bad_${Date.now()}`, type: 'text', text: { body: 'This should fail' }, timestamp: '1786973208' }], // no `from`
          },
        },
      ],
    }],
  };
  const body = JSON.stringify(payload);
  const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');

  const res = await fetch(`${baseUrl}/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
  assert.equal(res.status, 500, 'a genuine per-change write failure must not be reported as success to Meta');

  const { rows } = await pool.query(
    'select * from contacts where client_id = $1 and phone = $2',
    [testClientId, goodPhone]
  );
  assert.equal(rows.length, 1, 'the change that succeeded must have persisted despite the other one failing');
});
