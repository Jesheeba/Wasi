// Meta send pacing + 130429 retry (build-docs/features/meta-send-pacing.md).
// Unit tests use a fake clock; the end-to-end tests send through the real
// Hub API with only graph.facebook.com faked (local TEST_DATABASE_URL).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createSendThrottle, THROTTLE_CODE } = require('../src/utils/metaSendThrottle');

const throttled = () => Object.assign(new Error('(#130429) Rate limit hit'), { metaError: { code: THROTTLE_CODE } });

function fakeClock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

test('AC1: sends for one number are spaced 1/perSecond apart; other numbers are independent', async () => {
  const clock = fakeClock();
  const th = createSendThrottle({ perSecond: 10, now: clock.now, sleep: clock.sleep });
  const startedAt = [];
  for (let i = 0; i < 5; i++) await th.run('phone-A', async () => startedAt.push(clock.now()));
  assert.deepEqual(startedAt, [0, 100, 200, 300, 400]);
  const other = [];
  await th.run('phone-B', async () => other.push(clock.now()));
  assert.deepEqual(other, [400], 'phone-B did not wait behind phone-A');
});

test('AC1: a concurrent burst is queued, not refused', async () => {
  const th = createSendThrottle({ perSecond: 50 });
  const t0 = Date.now();
  const times = await Promise.all(Array.from({ length: 10 }, () => th.run('burst', async () => Date.now() - t0)));
  times.sort((a, b) => a - b);
  assert.ok(times[9] >= 9 * 20 - 15, `10 sends at 50/s span about 180ms (got ${times[9]}ms)`);
});

test('AC2: a 130429 is retried after a wait and then succeeds', async () => {
  const clock = fakeClock();
  const th = createSendThrottle({ perSecond: 10, now: clock.now, sleep: clock.sleep, retryDelaysMs: [1000, 2000] });
  let calls = 0;
  const result = await th.run('p', async () => { calls++; if (calls < 3) throw throttled(); return 'wamid.OK'; });
  assert.equal(result, 'wamid.OK');
  assert.equal(calls, 3);
  assert.ok(clock.sleeps.includes(1000) && clock.sleeps.includes(2000));
});

test('AC3: retries stop after the configured attempts; other errors are never retried', async () => {
  const clock = fakeClock();
  const th = createSendThrottle({ perSecond: 10, now: clock.now, sleep: clock.sleep, retryDelaysMs: [10, 10] });
  let calls = 0;
  await assert.rejects(th.run('p', async () => { calls++; throw throttled(); }), /130429/);
  assert.equal(calls, 3, '1 try + 2 retries');

  calls = 0;
  const badParams = Object.assign(new Error('(#132000)'), { metaError: { code: 132000 } });
  await assert.rejects(th.run('p', async () => { calls++; throw badParams; }), /132000/);
  assert.equal(calls, 1);
});

test('AC3b: retry: false paces but never retries (broadcast runner reschedules 130429 itself)', async () => {
  const clock = fakeClock();
  const th = createSendThrottle({ perSecond: 10, now: clock.now, sleep: clock.sleep, retryDelaysMs: [10, 10] });
  let calls = 0;
  await assert.rejects(th.run('p', async () => { calls++; throw throttled(); }, { retry: false }), /130429/);
  assert.equal(calls, 1);
});

test('AC4: when the queue for a number is longer than maxWaitMs, the send is refused at once', async () => {
  const clock = fakeClock();
  const th = createSendThrottle({ perSecond: 1, maxWaitMs: 3500, now: clock.now, sleep: async () => {} });
  await th.acquire('p'); await th.acquire('p'); await th.acquire('p'); await th.acquire('p'); // slots 0..3s
  await assert.rejects(th.acquire('p'), (err) => err.code === 'send_queue_full');
});

// --- End to end through POST /api/v1/messages ---------------------------
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const apiKeysRepo = require('../src/repositories/apiKeysRepo');
const { encrypt } = require('../src/utils/encryption');

const PHONE_ID = `test_pacing_phone_${Date.now()}`;
let server, BASE, clientId, apiKey, realFetch;
let graphSends = [];
let throttleNext = 0;
let wamidSeq = 0;

before(async () => {
  realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, options);
    if (u.includes(`${PHONE_ID}/messages`)) {
      graphSends.push(Date.now());
      if (throttleNext > 0) {
        throttleNext--;
        const err = { error: { code: 130429, message: '(#130429) Rate limit hit' } };
        return { ok: false, status: 400, json: async () => err, text: async () => JSON.stringify(err) };
      }
      const ok = { messages: [{ id: `wamid.TEST_${Date.now()}_${++wamidSeq}` }] };
      return { ok: true, status: 200, json: async () => ok, text: async () => JSON.stringify(ok) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  };
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://localhost:${server.address().port}`;
  const reg = await realFetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: '__test_suite__pacing client', email: `test-pacing-${Date.now()}@wasi.local`, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  clientId = reg.client.id;
  await pool.query("update clients set status = 'active' where id = $1", [clientId]);
  await wabasRepo.upsertForClient(clientId, {
    waba_id: `test_pacing_waba_${Date.now()}`, phone_number_id: PHONE_ID, status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });
  apiKey = (await apiKeysRepo.create(pool, clientId, '__test_suite__pacing')).rawKey;
});

after(async () => {
  global.fetch = realFetch;
  if (clientId) {
    await pool.query("delete from audit_log where actor_id = $1", [clientId]);
    await pool.query('delete from clients where id = $1', [clientId]);
  }
  await new Promise((r) => server.close(r));
  await pool.end();
});

// A text send needs an open 24h window: give the chat an inbound message.
async function openChat(phone) {
  const { rows: [contact] } = await pool.query(
    `insert into contacts (client_id, name, phone) values ($1, 'Pacing', $2) returning id`, [clientId, phone]);
  const { rows: [chat] } = await pool.query(
    `insert into chats (client_id, contact_id, name, phone) values ($1, $2, 'Pacing', $3) returning id`, [clientId, contact.id, phone]);
  await pool.query(
    `insert into messages (client_id, chat_id, direction, body, status, sent_at) values ($1, $2, 'in', 'hi', 'delivered', now())`, [clientId, chat.id]);
}

const sendText = (to) => realFetch(`${BASE}/api/v1/messages`, {
  method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_id: clientId, to, type: 'text', body: 'hello' }),
}).then(async (r) => ({ status: r.status, data: await r.json() }));

test('AC5 (end to end): a 130429 from Meta is retried and the API answers 201', async () => {
  const to = '919811100001';
  await openChat(to);
  graphSends = [];
  throttleNext = 1;
  const r = await sendText(to);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(graphSends.length, 2, 'one throttled attempt + one retry');
  assert.ok(graphSends[1] - graphSends[0] >= 900, 'waited about 1s before retrying');
});

test('AC6 (end to end): a burst of 20 API sends is paced, none refused', async () => {
  const phones = Array.from({ length: 20 }, (_, i) => `9198222${String(i).padStart(5, '0')}`);
  for (const p of phones) await openChat(p);
  graphSends = [];
  throttleNext = 0;
  const results = await Promise.all(phones.map(sendText));
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.filter((r) => r.status !== 201).slice(0, 2)));
  graphSends.sort((a, b) => a - b);
  const span = graphSends[graphSends.length - 1] - graphSends[0];
  assert.ok(span >= 19 * (1000 / 15) - 100, `20 sends at 15/s span about 1.2s (got ${span}ms)`);
});
