// Bug found 18 Sep 2026, present since b9affd5 (15 Sep): a failed chat send
// wrote its failure (status='failed', meta_error_code, error_reason) to the
// messages row, then had that exact write silently discarded.
//
// The chain: routes/chats.js releases the tenant connection before the Meta
// call (messagingService.sendChatMessage's connectionHooks), reacquires a
// FRESH transaction to write chatsRepo.markFailed on Meta rejection, then
// throws — the route responds 502. tenantContext.js's res.json wrapper calls
// finalize(res.statusCode < 500), i.e. finalize(false), which ROLLS BACK
// whatever transaction is current at that point — the fresh one holding the
// markFailed write, since nothing had committed it yet. The row was left
// 'pending' forever with meta_error_code/error_reason null, invisible to
// every healthy client because only a client whose sends are actually
// failing ever reaches this branch.
//
// The fix (messagingService.js's sendChatMessage/retryMessage catch blocks)
// calls connectionHooks.release() — which commits — right after markFailed,
// before throwing. This test proves the fix, not just the absence of an
// exception: it reads the message row back through `pool`, a BRAND NEW
// connection distinct from the one the request used, so a regression back to
// "written but rolled back" would show the row still 'pending' here even
// though the write appeared to succeed inside the request.
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

const SUITE_PREFIX = '__test_suite__failedsendcommit_';
const PASSWORD = 'test-suite-password-12345';

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
      email: `test-suite-failedsendcommit-${Date.now()}@wasi.local`,
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

const originalFetch = global.fetch;
const META_REJECTION = {
  message: 'You do not have the necessary permission to send messages on behalf of this WhatsApp Business Account',
  type: 'OAuthException',
  code: 200,
  error_subcode: 33,
  fbtrace_id: 'Az9TestTraceId',
};
function stubMetaRejection() {
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    return {
      ok: false,
      status: 400,
      json: async () => ({ error: META_REJECTION }),
    };
  };
}
function unstubMetaFetch() {
  global.fetch = originalFetch;
}

let phoneCounter = 0;
async function createOpenChat(suffix) {
  phoneCounter += 1;
  const phone = `9172${Date.now()}${phoneCounter}`;
  const contact = await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: `${SUITE_PREFIX}${suffix}`, wa_id: phone });
  const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
  // A real inbound message opens the 24h session window so a plain 'text'
  // send is even attempted, rather than rejected pre-flight for being
  // outside it (a different, non-Meta failure this bug doesn't touch).
  await chatsRepo.insertInbound(pool, testClientId, chat.id, {
    metaMessageId: `wamid.${SUITE_PREFIX}${suffix}_${Date.now()}`,
    body: 'a real customer message',
    sentAt: new Date().toISOString(),
  });
  return chat;
}

test('a Meta-rejected send commits status=failed + meta_error_code + meta_error_subcode, visible on a fresh connection', async () => {
  const chat = await createOpenChat('send');

  stubMetaRejection();
  let res;
  try {
    res = await fetch(`${baseUrl}/api/chats/${chat.id}/messages`, {
      method: 'POST',
      headers: authed(clientToken),
      body: JSON.stringify({ type: 'text', body: 'this will fail at Meta' }),
    });
  } finally {
    unstubMetaFetch();
  }

  assert.equal(res.status, 502, 'the route must still answer 502 — this bug was never about hiding the failure from the caller');
  const body = await res.json();
  assert.equal(body.code, 'send_failed');

  // A NEW connection, deliberately not the request's own — reading inside
  // the same transaction the bug rolled back would pass even with the bug
  // present, since the write is visible to itself before rollback.
  const { rows } = await pool.query(
    `select * from messages where client_id = $1 and chat_id = $2 and direction = 'out' order by sent_at desc limit 1`,
    [testClientId, chat.id]
  );
  assert.equal(rows.length, 1);
  const message = rows[0];
  assert.equal(message.status, 'failed', 'must be committed as failed, not left pending');
  assert.equal(message.meta_error_code, 200);
  assert.equal(message.meta_error_subcode, 33);
  assert.ok(message.error_reason && message.error_reason.includes('necessary permission'), 'error_reason must carry Meta\'s real message');
});

test('a Meta-rejected retry commits the same way', async () => {
  const chat = await createOpenChat('retry');

  // First, a genuine failed send to retry (same path as the test above).
  stubMetaRejection();
  let sendRes;
  try {
    sendRes = await fetch(`${baseUrl}/api/chats/${chat.id}/messages`, {
      method: 'POST',
      headers: authed(clientToken),
      body: JSON.stringify({ type: 'text', body: 'first attempt, will fail' }),
    });
  } finally {
    unstubMetaFetch();
  }
  assert.equal(sendRes.status, 502);

  const { rows: afterSend } = await pool.query(
    `select * from messages where client_id = $1 and chat_id = $2 and direction = 'out' order by sent_at desc limit 1`,
    [testClientId, chat.id]
  );
  assert.equal(afterSend[0].status, 'failed');
  const messageId = afterSend[0].id;

  // Retry, also rejected by Meta (a different subcode, to prove this is a
  // fresh write, not a leftover from the first attempt).
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    return { ok: false, status: 400, json: async () => ({ error: { ...META_REJECTION, error_subcode: 131031 } }) };
  };
  let retryRes;
  try {
    retryRes = await fetch(`${baseUrl}/api/chats/${chat.id}/messages/${messageId}/retry`, {
      method: 'POST',
      headers: authed(clientToken),
    });
  } finally {
    unstubMetaFetch();
  }
  assert.equal(retryRes.status, 502);

  const { rows: afterRetry } = await pool.query('select * from messages where id = $1', [messageId]);
  assert.equal(afterRetry[0].status, 'failed');
  assert.equal(afterRetry[0].meta_error_code, 200);
  assert.equal(afterRetry[0].meta_error_subcode, 131031, 'must reflect the RETRY\'s own rejection, proving this write actually committed');
});
