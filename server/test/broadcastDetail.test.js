// PLAN.md item 28 — per-recipient broadcast detail view (parts A-C: real
// delivered_at/read_at/failed_at timestamps, the Meta message-error map,
// and the new GET /:id, GET /:id/recipients, GET /:id/recipients/export
// routes). Builds one broadcast with exactly one recipient per bucket the
// header strip/table need to distinguish (pending, sent-no-further-status,
// delivered, read, failed post-send, failed pre-send, skipped) via direct
// repo calls — not by running broadcastRunner — so each bucket's real state
// is deliberately controlled rather than raced against timing.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const chatsRepo = require('../src/repositories/chatsRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const broadcastRecipientsRepo = require('../src/repositories/broadcastRecipientsRepo');

let server;
let baseUrl;
let clientToken;
let testClientId;
let broadcastId;
const recipientIds = {};

const SUITE_PREFIX = '__test_suite__broadcastdetail_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
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
      email: `test-suite-broadcastdetail-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  // A zero-recipient broadcast (an empty, freshly-created tag matches no
  // contact) — recipients are inserted directly below so this test controls
  // each one's exact status, not left to a real audience match/send.
  const tagRes = await fetch(`${baseUrl}/api/tags`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}empty_tag` }),
  }).then((r) => r.json());

  const createRes = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ title: `${SUITE_PREFIX}campaign`, templateName: 'unused', tag_id: tagRes.id }),
  });
  const broadcast = await createRes.json();
  assert.equal(createRes.status, 201, JSON.stringify(broadcast));
  broadcastId = broadcast.id;
  assert.equal(broadcast.recipient_count, 0);

  const base = Date.now().toString().slice(-7);
  async function makeContact(label, name) {
    const phone = `9196${base}${label}`;
    return contactsRepo.create(pool, testClientId, { name, phone });
  }
  async function makeRecipient(contactId) {
    const { rows } = await pool.query(
      'insert into broadcast_recipients (broadcast_id, client_id, contact_id) values ($1, $2, $3) returning id',
      [broadcastId, testClientId, contactId]
    );
    return rows[0].id;
  }
  async function makeSentMessage(chatId, metaMessageId) {
    const pending = await chatsRepo.insertOutboundPending(pool, testClientId, chatId, 'test broadcast body');
    const sent = await chatsRepo.markSent(pool, testClientId, pending.id, metaMessageId);
    return sent;
  }

  const chat = await chatsRepo.create(pool, testClientId, { name: 'Detail Test Chat', phone: `9195${base}` });

  // 1. Still pending — never claimed.
  const pendingContact = await makeContact('0', 'Pending Contact');
  recipientIds.pending = await makeRecipient(pendingContact.id);

  // 2. Sent, no further status webhook yet.
  const sentContact = await makeContact('1', 'Sent Only Contact');
  recipientIds.sent = await makeRecipient(sentContact.id);
  const sentMessage = await makeSentMessage(chat.id, `wamid.${SUITE_PREFIX}sent`);
  await broadcastRecipientsRepo.markSent(pool, recipientIds.sent, sentMessage.id);

  // 3. Delivered (real webhook-driven status update, same path metaWebhook.js uses).
  const deliveredContact = await makeContact('2', 'Delivered Contact');
  recipientIds.delivered = await makeRecipient(deliveredContact.id);
  const deliveredMessage = await makeSentMessage(chat.id, `wamid.${SUITE_PREFIX}delivered`);
  await broadcastRecipientsRepo.markSent(pool, recipientIds.delivered, deliveredMessage.id);
  await chatsRepo.updateStatusByMetaId(pool, testClientId, deliveredMessage.meta_message_id, 'delivered', null, null);

  // 4. Read.
  const readContact = await makeContact('3', 'Read Special Contact');
  recipientIds.read = await makeRecipient(readContact.id);
  const readMessage = await makeSentMessage(chat.id, `wamid.${SUITE_PREFIX}read`);
  await broadcastRecipientsRepo.markSent(pool, recipientIds.read, readMessage.id);
  await chatsRepo.updateStatusByMetaId(pool, testClientId, readMessage.meta_message_id, 'read', null, null);

  // 5. Failed AFTER Meta accepted the send (a real documented Meta code —
  // 131047, "re-engagement window closed" — reported via the status webhook).
  const failedPostContact = await makeContact('4', 'Failed Post-Send Contact');
  recipientIds.failedPostSend = await makeRecipient(failedPostContact.id);
  const failedMessage = await makeSentMessage(chat.id, `wamid.${SUITE_PREFIX}failedpost`);
  await broadcastRecipientsRepo.markSent(pool, recipientIds.failedPostSend, failedMessage.id);
  await chatsRepo.updateStatusByMetaId(pool, testClientId, failedMessage.meta_message_id, 'failed', 'Re-engagement message', 131047);

  // 6. Failed BEFORE ever reaching Meta (e.g. contact deleted mid-broadcast —
  // broadcastRecipientsRepo.claimBatch's own orphan-handling shape).
  const failedPreContact = await makeContact('5', 'Failed Pre-Send Contact');
  recipientIds.failedPreSend = await makeRecipient(failedPreContact.id);
  await broadcastRecipientsRepo.markFailed(pool, recipientIds.failedPreSend, 'Contact was deleted before this recipient could be sent.');

  // 7. Skipped (Smart Sending window).
  const skippedContact = await makeContact('6', 'Skipped Contact');
  recipientIds.skipped = await makeRecipient(skippedContact.id);
  await broadcastRecipientsRepo.markSkipped(pool, recipientIds.skipped, 'smart_sending_window');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('GET /:id returns metadata and a header-strip count for every bucket', async () => {
  const res = await fetch(`${baseUrl}/api/broadcasts/${broadcastId}`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.recipient_count, 7);
  assert.equal(body.pending_count, 1);
  assert.equal(body.sent_count, 4, 'sent/delivered/read/failed-post-send all reached broadcast_recipients.status = sent');
  assert.equal(body.delivered_count, 2, 'delivered + read both count as "at least delivered"');
  assert.equal(body.read_count, 1);
  assert.equal(body.failed_count, 2, 'one pre-send failure + one post-send failure');
  assert.equal(body.skipped_count, 1);
});

test('GET /:id on a broadcast belonging to another client (or a non-existent id) 404s', async () => {
  const res = await fetch(`${baseUrl}/api/broadcasts/00000000-0000-0000-0000-000000000099`, { headers: authed(clientToken) });
  assert.equal(res.status, 404);
});

test('GET /:id/recipients returns every recipient with its effective status, timestamp, and plain-language reason', async () => {
  const res = await fetch(`${baseUrl}/api/broadcasts/${broadcastId}/recipients`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.equal(rows.length, 7);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  assert.equal(byId[recipientIds.pending].status, 'pending');
  assert.equal(byId[recipientIds.pending].at, null, 'a never-claimed recipient has no timestamp to show');

  assert.equal(byId[recipientIds.sent].status, 'sent');
  assert.ok(byId[recipientIds.sent].at, 'a sent message must carry its sent_at time');

  assert.equal(byId[recipientIds.delivered].status, 'delivered');
  assert.ok(byId[recipientIds.delivered].at);

  assert.equal(byId[recipientIds.read].status, 'read');
  assert.ok(byId[recipientIds.read].at);

  assert.equal(byId[recipientIds.failedPostSend].status, 'failed');
  assert.match(byId[recipientIds.failedPostSend].reason, /24 hours/, 'a known Meta code (131047) must resolve to its plain-language mapping, not the raw Meta title');

  assert.equal(byId[recipientIds.failedPreSend].status, 'failed');
  assert.equal(byId[recipientIds.failedPreSend].reason, 'Contact was deleted before this recipient could be sent.', 'a pre-send failure has no Meta code, so its own recipient-level reason is shown verbatim');

  assert.equal(byId[recipientIds.skipped].status, 'skipped');
  assert.match(byId[recipientIds.skipped].reason, /Smart Sending/);
});

test('GET /:id/recipients?status=failed filters server-side to only the failed bucket', async () => {
  const res = await fetch(`${baseUrl}/api/broadcasts/${broadcastId}/recipients?status=failed`, { headers: authed(clientToken) });
  const rows = await res.json();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'failed'));
});

test('GET /:id/recipients?search= matches by contact name', async () => {
  const res = await fetch(`${baseUrl}/api/broadcasts/${broadcastId}/recipients?search=Read%20Special`, { headers: authed(clientToken) });
  const rows = await res.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, recipientIds.read);
});

test('GET /:id/recipients/export defaults to the failed bucket and returns a real CSV', async () => {
  const res = await fetch(`${baseUrl}/api/broadcasts/${broadcastId}/recipients/export`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const csv = await res.text();
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Name,Phone,Status,Timestamp,Reason');
  assert.equal(lines.length, 3, 'header row + exactly 2 failed recipients');
  assert.ok(lines.some((l) => l.includes('24 hours')));
  assert.ok(lines.some((l) => l.includes('Contact was deleted before this recipient could be sent.')));
});
