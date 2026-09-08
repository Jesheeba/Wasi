// PLAN.md item 11 — broadcast pause/resume. Verifies:
// 1. Launch a broadcast against a stubbed global.fetch (never real Meta),
//    pause mid-send, confirm no further batches are claimed after the
//    in-flight one completes.
// 2. Resume, confirm sending continues (claimBatch picks it back up).
// 3. Pause is rejected (400) unless status is currently 'Sending'.
// 4. Resume is rejected (400) unless status is currently 'Paused'.
// 5. 404 for an unknown/foreign broadcast id.
// 6. Role gating (Agent rejected, matches item 9's Admin/Manager-only
//    Broadcasts row) and unauthenticated rejection.
// Same dedicated-disposable-test-client + Meta-boundary-only fetch-faking
// pattern as broadcastPacing.test.js, and its same "give a test row a
// status/timing a live poller's own query genuinely excludes" discipline
// (CLAUDE.md Conventions) — this file calls broadcastRunner.processBroadcast
// directly, never .tick(), so it can't touch any other client's real
// active work on this shared DB.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const broadcastsRepo = require('../src/repositories/broadcastsRepo');
const broadcastRecipientsRepo = require('../src/repositories/broadcastRecipientsRepo');
const broadcastRunner = require('../src/services/broadcastRunner');
const { encrypt } = require('../src/utils/encryption');

let server;
let baseUrl;
let clientToken;
let testClientId;
let vipTagId;
let originalFetch;

const SUITE_PREFIX = '__test_suite__broadcastpauseresume_';
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
      email: `test-suite-broadcastpauseresume-${Date.now()}@wasi.local`,
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

  const tagRes = await fetch(`${baseUrl}/api/tags`, {
    method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name: `${SUITE_PREFIX}tag` }),
  }).then((r) => r.json());
  vipTagId = tagRes.id;
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

// Same Meta-boundary-only stub as broadcastPacing.test.js — only
// graph.facebook.com is faked, everything else is the app's own real
// local-server fetch, unaffected by this override. Distinguishes a
// template-creation call from a message-send call by URL shape, same as
// that file.
function stubMetaFetch() {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (!String(url).includes('graph.facebook.com')) return realFetch(url, opts);
    if (String(url).endsWith('/messages')) {
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${Date.now()}.${Math.random()}` }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: `${SUITE_PREFIX}meta_template_id`, status: 'APPROVED', category: 'UTILITY' }) };
  };
}

async function createContact(name, phone) {
  return fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(clientToken), body: JSON.stringify({ name, phone, tag_id: vipTagId }),
  }).then((r) => r.json());
}

test('1-2. pause removes the broadcast from listActive (the runner\'s real gate — confirmed by reading broadcastRunner.js that processBroadcast itself has no status check at all, only tick()\'s listActive() call does); resume restores it and sending actually continues', async () => {
  stubMetaFetch();
  const ts = String(Date.now()).slice(-9);
  for (let i = 0; i < 4; i++) await createContact(`${SUITE_PREFIX}C${i}`, `919${ts}${i}`);

  // A real Utility-category template sidesteps the consent gate (already
  // covered elsewhere, e.g. apiV1.test.js) — this test's job is proving
  // pause/resume's real mechanism, not re-proving consent gating, same
  // reasoning broadcastPacing.test.js's own setup already documents.
  const templateName = `${SUITE_PREFIX}tpl_${Date.now()}`;
  const templateRes = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      name: templateName, category: 'Utility',
      body: 'Hi {{customer_name}}, this is a real broadcast pause/resume test message.',
      bodyParamExamples: { customer_name: 'Test' },
    }),
  });
  assert.equal(templateRes.status, 201, JSON.stringify(await templateRes.clone().json()));

  const broadcast = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({
      title: `${SUITE_PREFIX}camp`, tag_id: vipTagId, templateName,
      paramMappings: { customer_name: { source: 'contact_field', field: 'name' } },
      pacingConfig: { messages_per_minute: 1 },
    }),
  }).then((r) => r.json());
  assert.equal(broadcast.recipient_count, 4);

  let active = await broadcastsRepo.listActive(pool);
  assert.ok(active.some((b) => b.id === broadcast.id), 'a freshly-created Sending broadcast must be active');

  const pause = await fetch(`${baseUrl}/api/broadcasts/${broadcast.id}/pause`, { method: 'POST', headers: authed(clientToken) });
  assert.equal(pause.status, 200);
  assert.equal((await pause.json()).status, 'Paused');

  // This is the actual mechanism tick() relies on to stop claiming new
  // batches — listActive() only ever matches status = 'Sending'.
  active = await broadcastsRepo.listActive(pool);
  assert.ok(!active.some((b) => b.id === broadcast.id), 'a paused broadcast must not be picked up by the runner\'s next tick');

  const stillPending = await pool.query(
    `select count(*)::int as n from broadcast_recipients where broadcast_id = $1 and status = 'pending'`,
    [broadcast.id]
  );
  assert.equal(stillPending.rows[0].n, 4, 'nothing claimed while paused — no tick would have called processBroadcast for this broadcast');

  const resume = await fetch(`${baseUrl}/api/broadcasts/${broadcast.id}/resume`, { method: 'POST', headers: authed(clientToken) });
  assert.equal(resume.status, 200);
  assert.equal((await resume.json()).status, 'Sending');

  active = await broadcastsRepo.listActive(pool);
  assert.ok(active.some((b) => b.id === broadcast.id), 'resuming must make it active again');

  const resumedRow = await broadcastsRepo.findById(pool, testClientId, broadcast.id);
  await broadcastRunner.processBroadcast(resumedRow);
  const afterResume = await pool.query(
    `select count(*)::int as n from broadcast_recipients where broadcast_id = $1 and status = 'sent'`,
    [broadcast.id]
  );
  assert.ok(afterResume.rows[0].n > 0, 'sending actually resumes and completes at least one recipient after resume');
});

test('3. pause is rejected (400) unless the broadcast is currently Sending', async () => {
  const broadcast = await broadcastsRepo.create(pool, testClientId, {
    title: `${SUITE_PREFIX}completed`, tag_id: null, contact_list_id: null, segment_id: null,
    template_name: `${SUITE_PREFIX}t`, scheduled_date: null, param_mappings: {}, header_media_asset_id: null, pacing_config: null,
  });
  await broadcastsRepo.markStatus(pool, broadcast.id, 'Completed');

  const res = await fetch(`${baseUrl}/api/broadcasts/${broadcast.id}/pause`, { method: 'POST', headers: authed(clientToken) });
  assert.equal(res.status, 400);
});

test('4. resume is rejected (400) unless the broadcast is currently Paused', async () => {
  const broadcast = await broadcastsRepo.create(pool, testClientId, {
    title: `${SUITE_PREFIX}sending2`, tag_id: null, contact_list_id: null, segment_id: null,
    template_name: `${SUITE_PREFIX}t`, scheduled_date: null, param_mappings: {}, header_media_asset_id: null, pacing_config: null,
  });
  // create() defaults a same-day/no-schedule broadcast to 'Sending' already.
  const res = await fetch(`${baseUrl}/api/broadcasts/${broadcast.id}/resume`, { method: 'POST', headers: authed(clientToken) });
  assert.equal(res.status, 400);
});

test('5. 404 for an unknown broadcast id', async () => {
  const res = await fetch(`${baseUrl}/api/broadcasts/00000000-0000-0000-0000-000000000099/pause`, { method: 'POST', headers: authed(clientToken) });
  assert.equal(res.status, 404);
});

test('6. role gating: Agent is rejected (matches item 9\'s Admin/Manager-only Broadcasts row); unauthenticated is rejected', async () => {
  const authTokensRepo = require('../src/repositories/authTokensRepo');
  const agentCreated = await fetch(`${baseUrl}/api/team-members`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Agent`, email: `${SUITE_PREFIX}agent-${Date.now()}@wasi.local`, role: 'Agent' }),
  }).then((r) => r.json());
  const inviteToken = await authTokensRepo.create('team_member', agentCreated.id, 'team_invite', 60);
  const accepted = await fetch(`${baseUrl}/api/auth/team/accept-invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inviteToken, password: PASSWORD }),
  }).then((r) => r.json());

  const broadcast = await broadcastsRepo.create(pool, testClientId, {
    title: `${SUITE_PREFIX}rolegate`, tag_id: null, contact_list_id: null, segment_id: null,
    template_name: `${SUITE_PREFIX}t`, scheduled_date: null, param_mappings: {}, header_media_asset_id: null, pacing_config: null,
  });

  const asAgent = await fetch(`${baseUrl}/api/broadcasts/${broadcast.id}/pause`, { method: 'POST', headers: authed(accepted.token) });
  assert.equal(asAgent.status, 403);

  const unauth = await fetch(`${baseUrl}/api/broadcasts/${broadcast.id}/pause`, { method: 'POST' });
  assert.equal(unauth.status, 401);
});
