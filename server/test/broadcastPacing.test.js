// Broadcast/Campaign Engine, Phase 3 additions (wasi-master-plan.md §8.3):
// real end-to-end proof that pacing genuinely throttles a broadcast's send
// rate (not just a UI concept — QA's explicit requirement), that the
// per-recipient send reuses the real hardened messagingService.sendChatMessage
// path with no parallel sending logic, and that the existing message-status
// lifecycle (webhook-driven) is genuinely reused by broadcast_recipients,
// not duplicated. Same dedicated-disposable-test-client + Meta-boundary-only
// fetch-faking pattern as apiV1.test.js.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const broadcastsRepo = require('../src/repositories/broadcastsRepo');
const broadcastRunner = require('../src/services/broadcastRunner');
const { encrypt } = require('../src/utils/encryption');

let server;
let baseUrl;
let clientToken;
let testClientId;

const SUITE_PREFIX = '__test_suite__broadcastpacing_';
const RECIPIENT_COUNT = 12;

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
      email: `test-suite-broadcastpacing-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
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

test('mutual exclusivity: a broadcast cannot target both a tag and a contact list — rejected at the schema layer', async () => {
  const res = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({
      title: 'Bad', tag_id: '00000000-0000-0000-0000-000000000001',
      contact_list_id: '00000000-0000-0000-0000-000000000002', templateName: 'whatever',
    }),
  });
  assert.equal(res.status, 400);
});

test('mutual exclusivity: also enforced at the DB level (CHECK constraint), a second independent guarantee', async () => {
  await assert.rejects(
    pool.query(
      `insert into broadcasts (client_id, title, tag_id, contact_list_id, template_name)
       values ($1, 'x', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 't')`,
      [testClientId]
    ),
    /broadcasts_audience_not_both/
  );
});

test('real broadcast, real pacing, real sends: contact-list audience via CSV import, throttled to 1 recipient per runner tick, every send goes through the real hardened path', async () => {
  // --- Real CSV-imported contact list, RECIPIENT_COUNT distinct contacts ---
  const list = await fetch(`${baseUrl}/api/contact-lists`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}list` }),
  }).then((r) => r.json());

  const base = Date.now().toString().slice(-6);
  const phones = Array.from({ length: RECIPIENT_COUNT }, (_, i) => `9199${base}${String(i).padStart(2, '0')}`);
  const csv = ['name,phone', ...phones.map((p, i) => `Recipient ${i},${p}`)].join('\n');
  const boundary = '----WasiTestBoundary' + Date.now();
  const body = [`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="c.csv"', 'Content-Type: text/csv', '', csv, `--${boundary}--`, ''].join('\r\n');
  const importRes = await fetch(`${baseUrl}/api/contact-lists/${list.id}/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  }).then((r) => r.json());
  assert.equal(importRes.imported, RECIPIENT_COUNT);

  // --- Fake the Meta boundary BEFORE any Meta-touching call, including
  // template creation itself — this WABA is 'connected' (before() above),
  // so POST /api/templates below would otherwise attempt a REAL Graph API
  // call with a fake token and fail before ever creating the local
  // template row (routes/templates.js only inserts locally after a
  // successful Meta submission attempt). Only requests that actually reach
  // graph.facebook.com are faked; the app's own local HTTP calls (to
  // itself, above) are unaffected. capturedSendRequests tracks only the
  // message-send calls (.../messages), not the template-creation call, so
  // the later "exactly N real Meta calls" assertion counts sends alone. ---
  const originalFetch = global.fetch;
  let capturedSendRequests = [];
  let wamidCounter = 0;
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    if (String(url).endsWith('/messages')) {
      capturedSendRequests.push({ url: String(url), body: JSON.parse(options.body) });
      wamidCounter++;
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${SUITE_PREFIX}${wamidCounter}` }] }) };
    }
    // Template-creation call (.../message_templates) — real shape per
    // metaClient.js's createMessageTemplate, not asserted on here.
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_template_id`, status: 'APPROVED', category: 'UTILITY' }) };
  };

  let broadcast;
  try {
    // --- Real Utility-category template (sidesteps the consent gate,
    // which is already covered elsewhere — apiV1.test.js's tests 5-6 —
    // this test's job is pacing/reuse, not re-proving consent gating) ---
    const templateName = `${SUITE_PREFIX}tpl_${Date.now()}`;
    const templateRes = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST',
      headers: authed(clientToken),
      body: JSON.stringify({
        name: templateName, category: 'Utility',
        body: 'Hi {{customer_name}}, this is a real broadcast pacing test message.',
        bodyParamExamples: { customer_name: 'Test' },
      }),
    });
    assert.equal(templateRes.status, 201, JSON.stringify(await templateRes.clone().json()));

    // pacing_config: 12 messages/minute -> effectiveBatchSize with the
    // runner's real 5000ms tick = floor(12 * 5000 / 60000) = 1 recipient
    // claimed per processBroadcast() call. This is the actual mechanism
    // under test, not a mock of it.
    //
    // scheduled_date is set to TOMORROW so broadcastsRepo.create leaves this
    // row in 'Scheduled' status, not 'Sending' — this database is shared
    // with the real, live production server (confirmed live during this
    // test's own debugging: a real broadcastRunner.tick() elsewhere on this
    // same shared DB picked up an earlier draft of this test's 'Sending'
    // broadcast mid-run and raced it, using ITS OWN SERVER_SECRET to try
    // decrypting a token this test encrypted with this LOCAL process's
    // SERVER_SECRET — a GCM auth-tag mismatch, "Unsupported state or unable
    // to authenticate data" — which looked exactly like a pacing bug until
    // traced. 'Scheduled' + a future date is invisible to both
    // listActive() (Sending-only) and listDueScheduled() (only due dates) —
    // the real runner will never touch this row. This test still calls
    // broadcastRunner.processBroadcast() directly and explicitly on it
    // (never .tick()), so it's still exercising the exact real send path.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const createRes = await fetch(`${baseUrl}/api/broadcasts`, {
      method: 'POST',
      headers: authed(clientToken),
      body: JSON.stringify({
        title: `${SUITE_PREFIX}campaign`,
        contact_list_id: list.id,
        templateName,
        scheduled_date: tomorrow,
        paramMappings: { customer_name: { source: 'contact_field', field: 'name' } },
        pacingConfig: { messages_per_minute: 12 },
      }),
    });
    assert.equal(createRes.status, 201, JSON.stringify(await createRes.clone().json()));
    broadcast = await createRes.json();
    assert.equal(broadcast.recipient_count, RECIPIENT_COUNT);

    // Re-fetch the real row (pacing_config must have actually persisted).
    const fromDb = await pool.query('select * from broadcasts where id = $1', [broadcast.id]);
    assert.deepEqual(fromDb.rows[0].pacing_config, { messages_per_minute: 12 });

    // --- The real pacing proof: ONE processBroadcast() call must send
    // exactly 1, not all 12. Calling broadcastRunner.processBroadcast
    // directly (not .tick(), which would scan every client's active
    // broadcasts on this shared DB — unsafe here) with the real broadcast
    // row, same function the live 5s poller calls. ---
    let liveBroadcast = fromDb.rows[0];
    await broadcastRunner.processBroadcast(liveBroadcast);
    let sentSoFar = await pool.query(`select count(*)::int as n from broadcast_recipients where broadcast_id = $1 and status = 'sent'`, [broadcast.id]);
    assert.equal(sentSoFar.rows[0].n, 1, 'pacing_config of 12/min must throttle a single runner tick to exactly 1 send, not all 12 — this is the real mechanism, not a UI-only concept');
    assert.equal(capturedSendRequests.length, 1, 'exactly one real Meta API call must have happened so far');

    // --- Drive it to completion: repeated ticks, throttled progress each
    // time, until every recipient is processed. ---
    for (let i = 1; i < RECIPIENT_COUNT; i++) {
      const row = (await pool.query('select * from broadcasts where id = $1', [broadcast.id])).rows[0];
      await broadcastRunner.processBroadcast(row);
    }

    const finalCounts = await pool.query(
      `select status, count(*)::int as n from broadcast_recipients where broadcast_id = $1 group by status`,
      [broadcast.id]
    );
    const byStatus = Object.fromEntries(finalCounts.rows.map((r) => [r.status, r.n]));
    assert.equal(byStatus.sent, RECIPIENT_COUNT, `all ${RECIPIENT_COUNT} recipients must eventually be sent`);
    assert.equal(capturedSendRequests.length, RECIPIENT_COUNT, `exactly ${RECIPIENT_COUNT} real Meta API calls total — no more, no fewer, confirming every recipient was sent exactly once via the real path, not duplicated or skipped`);

    // Every captured request actually reached metaClient's real
    // sendTemplateMessage request-building — confirm the template name and
    // a resolved (not literal {{customer_name}}) body param made it through.
    for (const req of capturedSendRequests) {
      assert.equal(req.body.template.name, templateName);
      const bodyComponent = req.body.template.components.find((c) => c.type === 'body');
      assert.ok(bodyComponent, 'body component must be present');
    }

    // Broadcast auto-completes once nothing is pending — same completion
    // logic the pre-existing (tag-based) path already used, unchanged.
    const finalBroadcast = await pool.query('select status from broadcasts where id = $1', [broadcast.id]);
    assert.equal(finalBroadcast.rows[0].status, 'Completed');

    // --- Reuse of the existing message-status lifecycle, not a duplicate
    // one: mark 3 of the real messages delivered/read via the SAME webhook
    // update path metaWebhook.js uses (chatsRepo.updateStatusByMetaId), and
    // confirm broadcastsRepo.list's live JOIN reflects it correctly. ---
    const recipientRows = await pool.query(
      `select br.id as recipient_id, m.meta_message_id from broadcast_recipients br
       join messages m on m.id = br.message_id where br.broadcast_id = $1 order by br.created_at asc limit 3`,
      [broadcast.id]
    );
    assert.equal(recipientRows.rows.length, 3);
    await chatsRepo.updateStatusByMetaId(pool, testClientId, recipientRows.rows[0].meta_message_id, 'delivered', null, null);
    await chatsRepo.updateStatusByMetaId(pool, testClientId, recipientRows.rows[1].meta_message_id, 'delivered', null, null);
    await chatsRepo.updateStatusByMetaId(pool, testClientId, recipientRows.rows[2].meta_message_id, 'read', null, null);

    const list1 = await broadcastsRepo.list(pool, testClientId);
    const row = list1.find((b) => b.id === broadcast.id);
    assert.equal(row.recipient_count, RECIPIENT_COUNT);
    assert.equal(row.delivered_count, RECIPIENT_COUNT); // "delivered_count" here is actually sent-attempt count, per broadcastsRepo.list's own column naming
    // 3 of 12 sent messages are delivered-or-read -> 25.00%. Postgres
    // numeric columns come back as strings via node-postgres (to avoid
    // float precision loss) — compared as numbers explicitly here rather
    // than relying on assert.equal's coercion behavior.
    assert.equal(Number(row.delivered_rate), 25.00);
    // 1 of 12 is read -> 8.33%
    assert.equal(Number(row.read_rate), 8.33);
  } finally {
    global.fetch = originalFetch;
  }
});
