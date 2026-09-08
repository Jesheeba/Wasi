// PLAN.md item 5 — SLA / First Response Time tracking. Verifies the 4
// cases the plan's own "Verify" text calls for, plus resolution tracking:
// 1. inbound -> team-member reply (real route): recorded against that
//    inbound's id.
// 2. inbound -> automated reply (messagingService called directly, the
//    same way flowEngine/broadcastRunner/apiV1Messages do — bypassing
//    routes/chats.js entirely): NOTHING recorded, since recording lives
//    only at that one route, guarded by actorType.
// 3. inbound -> automated reply -> team-member reply: first_response_seconds
//    measured from the ORIGINAL inbound, not from the automated reply.
// 4. two team-member replies to the same still-unanswered inbound: only
//    the first is recorded.
// 5/6. resolve without a prior first response creates a fresh row; resolve
//    after a first response fills in resolved_seconds without
//    reattributing team_member_id to whoever resolved it.
// 7. GET /api/analytics/sla aggregates correctly, Agent gets 403.
// 8. A chat resolved, reopened by a new inbound, then resolved again gets a
//    SECOND distinct chat_sla_logs row — the partial unique index is keyed
//    on (chat_id, inbound_message_id), and item 2's reopen-on-inbound gives
//    each round its own new inbound message id, so it doesn't collide.
// 9/10. alertOnWriteFailure opens a real alert_events row + calls
//    alertNotifier on a genuine write failure (a real FK violation, not
//    simulated), and dedupes a second failure into the same open row
//    instead of spamming a new one.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const authTokensRepo = require('../src/repositories/authTokensRepo');
const wabasRepo = require('../src/repositories/wabasRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const chatSlaLogsRepo = require('../src/repositories/chatSlaLogsRepo');
const alertEventsRepo = require('../src/repositories/alertEventsRepo');
const messagingService = require('../src/services/messagingService');
const { encrypt } = require('../src/utils/encryption');

let server;
let baseUrl;
let clientToken;
let testClientId;

const SUITE_PREFIX = '__test_suite__chatslalogs_';
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
      email: `test-suite-chatslalogs-${Date.now()}@wasi.local`,
      password: PASSWORD,
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  // A connected WABA + stubbed global.fetch (never real Meta) is needed for
  // both the real send route and the direct messagingService call below —
  // same setup pattern as apiV1.test.js's interactive/list send tests.
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
function stubMetaFetch() {
  global.fetch = async (url, options) => {
    if (!String(url).includes('graph.facebook.com')) return originalFetch(url, options);
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.FAKE_${Date.now()}_${Math.random()}` }] }) };
  };
}
function unstubMetaFetch() {
  global.fetch = originalFetch;
}

async function createTeamMemberJwt(role) {
  const created = await fetch(`${baseUrl}/api/team-members`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}${role}`, email: `${SUITE_PREFIX}${role}-${Date.now()}@wasi.local`, role }),
  }).then((r) => r.json());
  const token = await authTokensRepo.create('team_member', created.id, 'team_invite', 60);
  const accepted = await fetch(`${baseUrl}/api/auth/team/accept-invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password: PASSWORD }),
  }).then((r) => r.json());
  return { id: created.id, jwt: accepted.token };
}

// sentAt lets a case put the inbound far enough in the past to distinguish
// "measured from the inbound" from "measured from a reply sent seconds later".
//
// No length cap on this phone string (contacts.phone is plain text, no
// constraint) — an earlier version sliced this to 12 chars, which truncated
// off the uniqueness-bearing suffix and made every call in this file
// collide on the same contact/chat, corrupting every count-based
// assertion below. Found live by the tests themselves failing with
// incrementing counts across cases, not caught by inspection.
let phoneCounter = 0;
async function createChatWithInbound(suffix, sentAt) {
  phoneCounter += 1;
  const phone = `9171${Date.now()}${phoneCounter}`;
  const contact = await contactsRepo.upsertByPhone(pool, testClientId, { phone, name: `${SUITE_PREFIX}${suffix}`, wa_id: phone });
  const chat = await chatsRepo.findOrCreateByContact(pool, testClientId, contact);
  await chatsRepo.insertInbound(pool, testClientId, chat.id, {
    metaMessageId: `wamid.${SUITE_PREFIX}${suffix}_${Date.now()}`,
    body: 'a real customer message',
    sentAt,
  });
  return chat;
}

test('1. inbound then a team-member reply (real route) records first_response_seconds', async () => {
  const agent = await createTeamMemberJwt('Agent');
  const chat = await createChatWithInbound('case1', new Date().toISOString());

  stubMetaFetch();
  try {
    const res = await fetch(`${baseUrl}/api/chats/${chat.id}/messages`, {
      method: 'POST', headers: authed(agent.jwt), body: JSON.stringify({ type: 'text', body: 'On it!' }),
    });
    assert.equal(res.status, 201);
  } finally { unstubMetaFetch(); }

  const { rows } = await pool.query('select * from chat_sla_logs where chat_id = $1', [chat.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].team_member_id, agent.id);
  assert.ok(rows[0].first_response_seconds !== null);
});

test('2. inbound then an AUTOMATED reply (messagingService called directly, bypassing the route) records NOTHING', async () => {
  const chat = await createChatWithInbound('case2', new Date().toISOString());

  stubMetaFetch();
  try {
    await messagingService.sendChatMessage(pool, testClientId, chat, { type: 'text', body: 'automated: your order shipped' });
  } finally { unstubMetaFetch(); }

  const { rows } = await pool.query('select * from chat_sla_logs where chat_id = $1', [chat.id]);
  assert.equal(rows.length, 0, 'no chat_sla_logs row must exist — recording only happens at the routes/chats.js route');
});

test('3. inbound -> automated reply -> team-member reply: measured from the INBOUND, not the automated reply', async () => {
  const agent = await createTeamMemberJwt('Agent');
  // Inbound 100 seconds in the past — the automated reply and the
  // team-member reply both happen "now", so if the clock were (wrongly)
  // measured from the automated reply, first_response_seconds would read
  // near 0, not near 100.
  const inboundSentAt = new Date(Date.now() - 100_000).toISOString();
  const chat = await createChatWithInbound('case3', inboundSentAt);

  stubMetaFetch();
  try {
    await messagingService.sendChatMessage(pool, testClientId, chat, { type: 'text', body: 'automated: we got your message' });
    const res = await fetch(`${baseUrl}/api/chats/${chat.id}/messages`, {
      method: 'POST', headers: authed(agent.jwt), body: JSON.stringify({ type: 'text', body: 'a human here now' }),
    });
    assert.equal(res.status, 201);
  } finally { unstubMetaFetch(); }

  const { rows } = await pool.query('select * from chat_sla_logs where chat_id = $1', [chat.id]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].first_response_seconds >= 95, `expected ~100s (measured from the inbound), got ${rows[0].first_response_seconds}`);
});

test('4. two team-member replies to the same still-unanswered inbound: only the first is recorded', async () => {
  const agentA = await createTeamMemberJwt('Agent');
  const agentB = await createTeamMemberJwt('Agent');
  const chat = await createChatWithInbound('case4', new Date().toISOString());

  stubMetaFetch();
  try {
    const first = await fetch(`${baseUrl}/api/chats/${chat.id}/messages`, {
      method: 'POST', headers: authed(agentA.jwt), body: JSON.stringify({ type: 'text', body: 'first reply' }),
    });
    assert.equal(first.status, 201);
    const second = await fetch(`${baseUrl}/api/chats/${chat.id}/messages`, {
      method: 'POST', headers: authed(agentB.jwt), body: JSON.stringify({ type: 'text', body: 'second reply, same inbound' }),
    });
    assert.equal(second.status, 201);
  } finally { unstubMetaFetch(); }

  const { rows } = await pool.query('select * from chat_sla_logs where chat_id = $1', [chat.id]);
  assert.equal(rows.length, 1, 'still only one row for this inbound cycle');
  assert.equal(rows[0].team_member_id, agentA.id, 'attributed to whoever replied FIRST, not the second reply');
});

test('5. resolving a chat with no prior first-response creates a fresh row with only resolved_seconds set', async () => {
  const admin = await createTeamMemberJwt('Admin');
  const chat = await createChatWithInbound('case5', new Date().toISOString());

  const res = await fetch(`${baseUrl}/api/chats/${chat.id}/resolve`, { method: 'POST', headers: authed(admin.jwt) });
  assert.equal(res.status, 200);

  const { rows } = await pool.query('select * from chat_sla_logs where chat_id = $1', [chat.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].first_response_seconds, null);
  assert.ok(rows[0].resolved_seconds !== null);
  assert.equal(rows[0].team_member_id, admin.id);
});

test('6. resolving AFTER a first response fills in resolved_seconds without reattributing team_member_id', async () => {
  const agent = await createTeamMemberJwt('Agent');
  const admin = await createTeamMemberJwt('Admin');
  const chat = await createChatWithInbound('case6', new Date().toISOString());

  stubMetaFetch();
  try {
    const replyRes = await fetch(`${baseUrl}/api/chats/${chat.id}/messages`, {
      method: 'POST', headers: authed(agent.jwt), body: JSON.stringify({ type: 'text', body: 'agent replies first' }),
    });
    assert.equal(replyRes.status, 201);
  } finally { unstubMetaFetch(); }

  // A different person (Admin) resolves it.
  const resolveRes = await fetch(`${baseUrl}/api/chats/${chat.id}/resolve`, { method: 'POST', headers: authed(admin.jwt) });
  assert.equal(resolveRes.status, 200);

  const { rows } = await pool.query('select * from chat_sla_logs where chat_id = $1', [chat.id]);
  assert.equal(rows.length, 1, 'the resolve upserts into the SAME row the first-response insert created');
  assert.ok(rows[0].first_response_seconds !== null);
  assert.ok(rows[0].resolved_seconds !== null);
  assert.equal(rows[0].team_member_id, agent.id, 'stays attributed to the agent who actually replied, not the admin who resolved it');
});

test('7. GET /api/analytics/sla aggregates by team member, Agent gets 403', async () => {
  const admin = await createTeamMemberJwt('Admin');
  const agentForbidden = await createTeamMemberJwt('Agent');

  const forbiddenRes = await fetch(`${baseUrl}/api/analytics/sla`, { headers: authed(agentForbidden.jwt) });
  assert.equal(forbiddenRes.status, 403);

  const res = await fetch(`${baseUrl}/api/analytics/sla`, { headers: authed(admin.jwt) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.byTeamMember));
  // From the tests above, at least one row must belong to a real named
  // agent (not just the Owner bucket) and carry a non-null average.
  const named = data.byTeamMember.find((r) => r.teamMemberId && r.avgFirstResponseSeconds !== null);
  assert.ok(named, 'expected at least one named team member with a recorded average');
});

test('8. resolve -> reopen (new inbound) -> resolve again creates a SECOND distinct chat_sla_logs row, not a collision', async () => {
  const admin = await createTeamMemberJwt('Admin');
  const chat = await createChatWithInbound('case8', new Date().toISOString());

  // Round 1: resolve immediately (no reply needed for this test).
  const firstResolve = await fetch(`${baseUrl}/api/chats/${chat.id}/resolve`, { method: 'POST', headers: authed(admin.jwt) });
  assert.equal(firstResolve.status, 200);

  let rows = (await pool.query('select * from chat_sla_logs where chat_id = $1 order by created_at asc', [chat.id])).rows;
  assert.equal(rows.length, 1);
  const firstInboundMessageId = rows[0].inbound_message_id;

  // Reopen via a NEW inbound message — item 2's insertInbound flips status
  // back to 'open' and this is a genuinely new messages row, with its own id.
  await chatsRepo.insertInbound(pool, testClientId, chat.id, {
    metaMessageId: `wamid.${SUITE_PREFIX}case8_round2_${Date.now()}`,
    body: 'customer replies again after resolution',
  });
  const chatAfterReopen = (await pool.query('select * from chats where id = $1', [chat.id])).rows[0];
  assert.equal(chatAfterReopen.status, 'open', 'sanity check: the new inbound really did reopen it');

  // Round 2: resolve again.
  const secondResolve = await fetch(`${baseUrl}/api/chats/${chat.id}/resolve`, { method: 'POST', headers: authed(admin.jwt) });
  assert.equal(secondResolve.status, 200);

  rows = (await pool.query('select * from chat_sla_logs where chat_id = $1 order by created_at asc', [chat.id])).rows;
  assert.equal(rows.length, 2, 'a second round must get its own row, not collide with round 1\'s via the partial unique index');
  assert.notEqual(rows[1].inbound_message_id, firstInboundMessageId, 'the second row must be keyed to the NEW inbound, not the original one');
});

test('9. a genuine chat_sla_logs write failure (real FK violation, not simulated) opens a real alert_events row and notifies', async () => {
  // Clean slate: resolve any alert this dedup key already has open from a
  // prior run of this suite (findOpen only ever returns the currently-open
  // one, so this makes the test self-contained regardless of run history).
  const preExisting = await alertEventsRepo.findOpen('chat_sla_write_failed', 'global');
  if (preExisting) await alertEventsRepo.resolveNow(preExisting.id);

  const chat = await createChatWithInbound('case9', new Date().toISOString());
  // A non-existent inbound message id — chat_sla_logs.inbound_message_id
  // has a real FK to messages(id), so this INSERT genuinely violates it,
  // the same class of failure the non-fatal catch blocks in routes/chats.js
  // are guarding against — not a mocked/simulated error.
  const fakeInbound = { id: '00000000-0000-0000-0000-000000000099', sent_at: new Date().toISOString() };
  let realError = null;
  try {
    await chatSlaLogsRepo.recordFirstResponseIfAbsent(pool, testClientId, chat.id, null, fakeInbound);
  } catch (err) {
    realError = err;
  }
  assert.ok(realError, 'the write must genuinely fail, not silently no-op — otherwise this test proves nothing');
  assert.match(realError.message, /violates foreign key constraint/);

  // Pass the REAL caught error through, exactly as routes/chats.js's catch
  // blocks do — not a fabricated one.
  await chatSlaLogsRepo.alertOnWriteFailure(realError);

  const opened = await alertEventsRepo.findOpen('chat_sla_write_failed', 'global');
  assert.ok(opened, 'a real alert_events row must now be open');
  assert.equal(opened.severity, 'warning');
  assert.ok(opened.notified_at, 'markNotified must have been called — alertNotifier.notify was actually invoked, not skipped');
});

test('10. a second failure dedupes into the SAME open alert instead of creating a new one (no spam)', async () => {
  const before = await alertEventsRepo.findOpen('chat_sla_write_failed', 'global');
  assert.ok(before, 'test 9 must have left this alert open');
  const beforeLastSeen = before.last_seen_at;

  await new Promise((resolve) => setTimeout(resolve, 50));
  await chatSlaLogsRepo.alertOnWriteFailure(new Error('a second, unrelated-looking failure'));

  const { rows: openRows } = await pool.query(
    `select * from alert_events where alert_type = 'chat_sla_write_failed' and resolved_at is null`
  );
  assert.equal(openRows.length, 1, 'must still be exactly one open alert, not a second one');
  assert.equal(openRows[0].id, before.id);
  assert.ok(new Date(openRows[0].last_seen_at) > new Date(beforeLastSeen), 'last_seen_at must have been touched');

  // Clean up — leave this global (not tenant-scoped, not cascade-deleted by
  // this file's after()) alert resolved so it doesn't linger for other
  // suites/runs.
  await alertEventsRepo.resolveNow(before.id);
});
