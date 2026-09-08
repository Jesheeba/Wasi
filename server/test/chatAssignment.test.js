// PLAN.md item 2 — chat assignment + open/resolved status. Verifies:
// 1. The backfill logic's 3 cases (migration 045_chat_assignment_status.js)
//    against synthetic data, inline — migrations don't re-run once
//    recorded, so this proves the ALGORITHM the migration encodes is
//    correct (the thing worth regression-protecting), run directly against
//    disposable test chats rather than re-invoking the migration file.
// 2. Assign/unassign self-vs-someone-else role split (Agent can only touch
//    their own assignment; Admin/Manager can touch anyone's).
// 3. Resolve/reopen are Admin/Manager only.
// 4. GET /api/chats?status=&assignedTo= filters.
// 5. A new inbound message reopens a resolved chat (keeping its
//    assignment); an outbound message never does.
// Same dedicated-disposable-test-client convention as every other file in
// this directory.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const authTokensRepo = require('../src/repositories/authTokensRepo');
const chatsRepo = require('../src/repositories/chatsRepo');

let server;
let baseUrl;
let clientToken;
let testClientId;

const SUITE_PREFIX = '__test_suite__chatassignment_';
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
      email: `test-suite-chatassignment-${Date.now()}@wasi.local`,
      password: PASSWORD,
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

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

async function createChat(name) {
  return fetch(`${baseUrl}/api/chats`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name, phone: `9170${Date.now()}`.slice(0, 12) }),
  }).then((r) => r.json());
}

// Mirrors migration 045's exact backfill UPDATE, run against synthetic rows
// this test creates and cleans up itself — proves the algorithm, not a
// literal re-run of the (already-applied, non-repeatable) migration file.
async function runBackfillOn(chatIds) {
  await pool.query(
    `update chats c
     set status = 'resolved'
     where c.id = any($1::uuid[]) and not exists (
       select 1 from messages m_in
       where m_in.chat_id = c.id
         and m_in.direction = 'in'
         and m_in.sent_at > now() - interval '24 hours'
         and not exists (
           select 1 from messages m_out
           where m_out.chat_id = c.id
             and m_out.direction = 'out'
             and m_out.sent_at >= m_in.sent_at
         )
     )`,
    [chatIds]
  );
}

test('1. backfill: an unanswered inbound within 24h stays open', async () => {
  const chat = await createChat(`${SUITE_PREFIX}case1`);
  await pool.query(
    `insert into messages (chat_id, client_id, direction, body, sent_at) values ($1, $2, 'in', 'hi', now() - interval '1 hour')`,
    [chat.id, testClientId]
  );
  await runBackfillOn([chat.id]);
  const { rows } = await pool.query('select status from chats where id = $1', [chat.id]);
  assert.equal(rows[0].status, 'open');
});

test('2. backfill: an answered inbound (even at the identical timestamp) resolves', async () => {
  const chat = await createChat(`${SUITE_PREFIX}case2`);
  const sentAt = new Date().toISOString();
  await pool.query(
    `insert into messages (chat_id, client_id, direction, body, sent_at) values ($1, $2, 'in', 'hi', $3)`,
    [chat.id, testClientId, sentAt]
  );
  // Same timestamp as the inbound, on purpose — this is the exact case
  // found live via seed.js (both messages land inside one transaction, so
  // Postgres's now() is identical for both) that the >= fix addresses.
  await pool.query(
    `insert into messages (chat_id, client_id, direction, body, sent_at) values ($1, $2, 'out', 'reply', $3)`,
    [chat.id, testClientId, sentAt]
  );
  await runBackfillOn([chat.id]);
  const { rows } = await pool.query('select status from chats where id = $1', [chat.id]);
  assert.equal(rows[0].status, 'resolved');
});

test('3. backfill: an inbound older than 24h with no reply resolves (stale, not a live triage item)', async () => {
  const chat = await createChat(`${SUITE_PREFIX}case3`);
  await pool.query(
    `insert into messages (chat_id, client_id, direction, body, sent_at) values ($1, $2, 'in', 'hi', now() - interval '2 days')`,
    [chat.id, testClientId]
  );
  await runBackfillOn([chat.id]);
  const { rows } = await pool.query('select status from chats where id = $1', [chat.id]);
  assert.equal(rows[0].status, 'resolved');
});

test('4. assign: an Agent can assign a chat to themselves', async () => {
  const agent = await createTeamMemberJwt('Agent');
  const chat = await createChat(`${SUITE_PREFIX}assign-self`);
  const res = await fetch(`${baseUrl}/api/chats/${chat.id}/assign`, {
    method: 'POST',
    headers: authed(agent.jwt),
    body: JSON.stringify({ teamMemberId: agent.id }),
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.assigned_team_member_id, agent.id);
});

test('5. assign: an Agent CANNOT assign a chat to someone else (403)', async () => {
  const agentA = await createTeamMemberJwt('Agent');
  const agentB = await createTeamMemberJwt('Agent');
  const chat = await createChat(`${SUITE_PREFIX}assign-other`);
  const res = await fetch(`${baseUrl}/api/chats/${chat.id}/assign`, {
    method: 'POST',
    headers: authed(agentA.jwt),
    body: JSON.stringify({ teamMemberId: agentB.id }),
  });
  assert.equal(res.status, 403);
});

test('6. assign: an Admin CAN assign a chat to someone else', async () => {
  const admin = await createTeamMemberJwt('Admin');
  const agent = await createTeamMemberJwt('Agent');
  const chat = await createChat(`${SUITE_PREFIX}assign-admin`);
  const res = await fetch(`${baseUrl}/api/chats/${chat.id}/assign`, {
    method: 'POST',
    headers: authed(admin.jwt),
    body: JSON.stringify({ teamMemberId: agent.id }),
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.assigned_team_member_id, agent.id);
});

test('7. assign: a teamMemberId that does not belong to this client is rejected', async () => {
  const admin = await createTeamMemberJwt('Admin');
  const chat = await createChat(`${SUITE_PREFIX}assign-badid`);
  const res = await fetch(`${baseUrl}/api/chats/${chat.id}/assign`, {
    method: 'POST',
    headers: authed(admin.jwt),
    body: JSON.stringify({ teamMemberId: '00000000-0000-0000-0000-000000000099' }),
  });
  assert.equal(res.status, 400);
});

test('8. unassign: an Agent can unassign a chat currently assigned to themselves, not someone else\'s', async () => {
  const agentA = await createTeamMemberJwt('Agent');
  const agentB = await createTeamMemberJwt('Agent');
  const admin = await createTeamMemberJwt('Admin');

  const ownChat = await createChat(`${SUITE_PREFIX}unassign-own`);
  await fetch(`${baseUrl}/api/chats/${ownChat.id}/assign`, { method: 'POST', headers: authed(agentA.jwt), body: JSON.stringify({ teamMemberId: agentA.id }) });
  const unassignOwn = await fetch(`${baseUrl}/api/chats/${ownChat.id}/unassign`, { method: 'POST', headers: authed(agentA.jwt) });
  assert.equal(unassignOwn.status, 200);

  const othersChat = await createChat(`${SUITE_PREFIX}unassign-others`);
  await fetch(`${baseUrl}/api/chats/${othersChat.id}/assign`, { method: 'POST', headers: authed(admin.jwt), body: JSON.stringify({ teamMemberId: agentB.id }) });
  const unassignOthers = await fetch(`${baseUrl}/api/chats/${othersChat.id}/unassign`, { method: 'POST', headers: authed(agentA.jwt) });
  assert.equal(unassignOthers.status, 403);
});

test('9. resolve/reopen are Admin/Manager only — an Agent gets 403', async () => {
  const agent = await createTeamMemberJwt('Agent');
  const chat = await createChat(`${SUITE_PREFIX}resolve-agent`);
  const resolveRes = await fetch(`${baseUrl}/api/chats/${chat.id}/resolve`, { method: 'POST', headers: authed(agent.jwt) });
  assert.equal(resolveRes.status, 403);
  const reopenRes = await fetch(`${baseUrl}/api/chats/${chat.id}/reopen`, { method: 'POST', headers: authed(agent.jwt) });
  assert.equal(reopenRes.status, 403);
});

test('10. resolve then reopen round-trips status, Admin allowed', async () => {
  const admin = await createTeamMemberJwt('Admin');
  const chat = await createChat(`${SUITE_PREFIX}resolve-admin`);
  const resolveRes = await fetch(`${baseUrl}/api/chats/${chat.id}/resolve`, { method: 'POST', headers: authed(admin.jwt) });
  assert.equal(resolveRes.status, 200);
  assert.equal((await resolveRes.json()).status, 'resolved');

  const reopenRes = await fetch(`${baseUrl}/api/chats/${chat.id}/reopen`, { method: 'POST', headers: authed(admin.jwt) });
  assert.equal(reopenRes.status, 200);
  assert.equal((await reopenRes.json()).status, 'open');
});

test('11. GET /api/chats?status=resolved and ?assignedTo=me/unassigned filter correctly', async () => {
  const admin = await createTeamMemberJwt('Admin');
  const openChat = await createChat(`${SUITE_PREFIX}filter-open`);
  const resolvedChat = await createChat(`${SUITE_PREFIX}filter-resolved`);
  await fetch(`${baseUrl}/api/chats/${resolvedChat.id}/resolve`, { method: 'POST', headers: authed(admin.jwt) });
  await fetch(`${baseUrl}/api/chats/${openChat.id}/assign`, { method: 'POST', headers: authed(admin.jwt), body: JSON.stringify({ teamMemberId: admin.id }) });

  const resolvedList = await fetch(`${baseUrl}/api/chats?status=resolved`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.ok(resolvedList.some((c) => c.id === resolvedChat.id));
  assert.ok(!resolvedList.some((c) => c.id === openChat.id));

  const meList = await fetch(`${baseUrl}/api/chats?assignedTo=me`, { headers: authed(admin.jwt) }).then((r) => r.json());
  assert.ok(meList.some((c) => c.id === openChat.id));

  const unassignedList = await fetch(`${baseUrl}/api/chats?assignedTo=unassigned`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.ok(!unassignedList.some((c) => c.id === openChat.id), 'the now-assigned chat must not appear in the unassigned filter');
});

test('12. a new inbound message reopens a resolved chat, keeping its assignment intact', async () => {
  const admin = await createTeamMemberJwt('Admin');
  const chat = await createChat(`${SUITE_PREFIX}reopen-inbound`);
  await fetch(`${baseUrl}/api/chats/${chat.id}/assign`, { method: 'POST', headers: authed(admin.jwt), body: JSON.stringify({ teamMemberId: admin.id }) });
  await fetch(`${baseUrl}/api/chats/${chat.id}/resolve`, { method: 'POST', headers: authed(admin.jwt) });

  await chatsRepo.insertInbound(pool, testClientId, chat.id, { metaMessageId: `wamid.test_reopen_${Date.now()}`, body: 'still there?' });

  const { rows } = await pool.query('select status, assigned_team_member_id from chats where id = $1', [chat.id]);
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].assigned_team_member_id, admin.id, 'the assignment must survive the reopen');
});

test('13. an outbound message does NOT reopen a resolved chat', async () => {
  const admin = await createTeamMemberJwt('Admin');
  const chat = await createChat(`${SUITE_PREFIX}no-reopen-outbound`);
  await fetch(`${baseUrl}/api/chats/${chat.id}/resolve`, { method: 'POST', headers: authed(admin.jwt) });

  await chatsRepo.insertOutboundPending(pool, testClientId, chat.id, 'a note sent while resolved');

  const { rows } = await pool.query('select status from chats where id = $1', [chat.id]);
  assert.equal(rows[0].status, 'resolved');
});
