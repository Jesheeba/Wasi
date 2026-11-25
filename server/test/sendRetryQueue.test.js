// Send retry queue (build-docs/features/send-retry-queue.md). Only
// graph.facebook.com is faked; real app + local TEST_DATABASE_URL.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { isTransientMetaError } = require('../src/utils/metaSendThrottle');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const apiKeysRepo = require('../src/repositories/apiKeysRepo');
const messageRetryRunner = require('../src/services/messageRetryRunner');
const { encrypt } = require('../src/utils/encryption');

const meta = (code) => Object.assign(new Error(`(#${code})`), { metaError: { code } });

test('AC1: transient = network, timeout, 5xx and Meta temporary codes; not recipient/content errors', () => {
  for (const e of [new Error('fetch failed (ECONNRESET)'), new Error('fetch failed'), new Error('Meta API request timed out after 20s'),
    new Error('Meta Graph API error (503)'), meta(130429), meta(131000), meta(131016), meta(133004), meta(2), meta(131056)]) {
    assert.equal(isTransientMetaError(e), true, e.message);
  }
  for (const e of [meta(131026), meta(132000), meta(131047), meta(131009), meta(100), new Error('Template "x" has no parameters'), null]) {
    assert.equal(isTransientMetaError(e), false, e?.message);
  }
});

// --- End to end ---------------------------------------------------------
const PHONE_ID = `test_retryq_phone_${Date.now()}`;
let server, BASE, clientId, apiKey, realFetch;
let mode = 'ok'; // 'ok' | 'network' | 'networkOnce' | 'permanent'
let graphCalls = 0;
let seq = 0;

before(async () => {
  realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, options);
    if (!u.includes(`${PHONE_ID}/messages`)) return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    graphCalls++;
    if (mode === 'network' || (mode === 'networkOnce' && graphCalls === 1)) {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }
    if (mode === 'permanent') {
      const err = { error: { code: 131026, message: 'Message undeliverable' } };
      return { ok: false, status: 400, json: async () => err, text: async () => JSON.stringify(err) };
    }
    const ok = { messages: [{ id: `wamid.RETRYQ_${Date.now()}_${++seq}` }] };
    return { ok: true, status: 200, json: async () => ok, text: async () => JSON.stringify(ok) };
  };
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://localhost:${server.address().port}`;
  const reg = await realFetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: '__test_suite__retryq client', email: `test-retryq-${Date.now()}@wasi.local`, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  clientId = reg.client.id;
  await pool.query("update clients set status = 'active' where id = $1", [clientId]);
  await wabasRepo.upsertForClient(clientId, {
    waba_id: `test_retryq_waba_${Date.now()}`, phone_number_id: PHONE_ID, status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });
  apiKey = (await apiKeysRepo.create(pool, clientId, '__test_suite__retryq')).rawKey;
});

after(async () => {
  global.fetch = realFetch;
  if (clientId) {
    await pool.query('delete from audit_log where actor_id = $1', [clientId]);
    await pool.query('delete from clients where id = $1', [clientId]);
  }
  await new Promise((r) => server.close(r));
  await pool.end();
});

async function openChat(phone) {
  const { rows: [contact] } = await pool.query(`insert into contacts (client_id, name, phone) values ($1, 'RetryQ', $2) returning id`, [clientId, phone]);
  const { rows: [chat] } = await pool.query(`insert into chats (client_id, contact_id, name, phone) values ($1, $2, 'RetryQ', $3) returning id`, [clientId, contact.id, phone]);
  await pool.query(`insert into messages (client_id, chat_id, direction, body, status, sent_at) values ($1, $2, 'in', 'hi', 'delivered', now())`, [clientId, chat.id]);
}

let phoneSeq = 0;
async function send() {
  const to = `91983${String(Date.now()).slice(-5)}${String(phoneSeq++).padStart(2, '0')}`;
  await openChat(to);
  graphCalls = 0;
  const r = await realFetch(`${BASE}/api/v1/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, to, type: 'text', body: 'hello' }),
  });
  return { status: r.status, data: await r.json() };
}
const row = async (id) => (await pool.query('select * from messages where id = $1', [id])).rows[0];
const makeDue = (id) => pool.query("update messages set next_retry_at = now() - interval '1 second' where id = $1", [id]);

test('AC2: a network blip that clears on the inline retry sends normally (201)', async () => {
  mode = 'networkOnce';
  const r = await send();
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.status, 'sent');
  assert.equal(graphCalls, 2);
});

let queuedId;
test('AC3: a send that keeps failing on the network is queued: 202, pending, stored call without the token', async () => {
  mode = 'network';
  const r = await send();
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.queued, true);
  assert.equal(r.data.status, 'pending');
  assert.equal(graphCalls, 4, '1 try + 3 inline retries');
  queuedId = r.data.id;
  const m = await row(queuedId);
  assert.equal(m.status, 'pending');
  assert.equal(m.send_request.fn, 'sendTextMessage');
  assert.equal(m.send_request.args[1], 'hello');
  assert.ok(!JSON.stringify(m.send_request).includes('fake-token'), 'access token is never stored');
  assert.match(m.error_reason, /Queued for retry: fetch failed \(ECONNRESET\)/);
  assert.ok(new Date(m.next_retry_at) > new Date(), 'scheduled in the future');

  const status = await realFetch(`${BASE}/api/v1/messages/${queuedId}/status`, { headers: { Authorization: `Bearer ${apiKey}` } }).then((x) => x.json());
  assert.equal(status.status, 'pending');
  assert.ok(status.next_retry_at);
});

test('AC4: the runner sends a due queued message: sent, Meta id stored, queue cleared', async () => {
  mode = 'ok';
  await makeDue(queuedId);
  await messageRetryRunner.tick();
  const m = await row(queuedId);
  assert.equal(m.status, 'sent');
  assert.match(m.meta_message_id, /^wamid\.RETRYQ_/);
  assert.equal(m.send_request, null);
  assert.equal(m.next_retry_at, null);
  assert.equal(m.error_reason, null);
});

test('AC5: on retry, a still-failing network reschedules; a permanent error or running out of retries fails it', async () => {
  mode = 'network';
  const { data } = await send();
  assert.equal(data.queued, true);

  await makeDue(data.id);
  await messageRetryRunner.tick();
  let m = await row(data.id);
  assert.equal(m.status, 'pending');
  assert.equal(m.retry_count, 1);
  assert.ok(new Date(m.next_retry_at) > new Date());

  // Last allowed retry also fails on the network -> gives up.
  await pool.query('update messages set retry_count = $2 where id = $1', [data.id, messageRetryRunner.MAX_RETRIES - 1]);
  await makeDue(data.id);
  await messageRetryRunner.tick();
  m = await row(data.id);
  assert.equal(m.status, 'failed');
  assert.match(m.error_reason, /Gave up after 6 retries/);

  // A permanent Meta error on retry fails at once.
  const second = (await send()).data;
  mode = 'permanent';
  await makeDue(second.id);
  await messageRetryRunner.tick();
  m = await row(second.id);
  assert.equal(m.status, 'failed');
  assert.equal(m.meta_error_code, 131026);
  assert.equal(m.send_request, null);
});

test('AC6: a permanent error on the first send still answers 502 send_failed and is not queued', async () => {
  mode = 'permanent';
  const r = await send();
  assert.equal(r.status, 502);
  assert.equal(r.data.error.code, 'send_failed');
  assert.equal(graphCalls, 1, 'not retried inline');
});
