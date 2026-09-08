// PLAN.md item 10 — Contact 360 activity timeline. Verifies:
// 1. A new contact with no history returns { events: [] }.
// 2. A contact with mixed history (message in, message out, a sent
//    broadcast, a flow entry, a consent change) returns all 5, correctly
//    interleaved in real descending chronological order across all 4
//    event sources — not just correct within one source.
// 3. Only 'sent' broadcast_recipients rows appear (not pending/failed/skipped).
// 4. Only 'entered' flow_events rows appear (not the step-by-step ones).
// 5. Tenant isolation — another client's contact's history never leaks in.
// 6. Role gating (Agent allowed, matching every other Contacts sub-route)
//    and unauthenticated rejection; 404 for an unknown contact id.
// Same dedicated-disposable-test-client convention as every other file in
// this directory. Fixture events are inserted directly (pool.query, precise
// now() - interval offsets) rather than through the real send/broadcast/flow
// pipelines — same established pattern as chatAssignment.test.js's own
// direct message inserts, needed here for exact, non-flaky cross-source
// ordering control.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;
let clientToken;
let testClientId;
let otherClientToken;
let otherClientId;

const SUITE_PREFIX = '__test_suite__contacttimeline_';
const PASSWORD = 'test-suite-password-12345';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function registerClient(suffix) {
  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client_${suffix}`,
      email: `test-suite-contacttimeline-${suffix}-${Date.now()}@wasi.local`,
      password: PASSWORD,
    }),
  }).then((r) => r.json());
  return { token: registered.token, id: registered.client?.id };
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const primary = await registerClient('primary');
  clientToken = primary.token;
  testClientId = primary.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  const other = await registerClient('other');
  otherClientToken = other.token;
  otherClientId = other.id;
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  if (otherClientId) await pool.query('delete from clients where id = $1', [otherClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('1. a new contact with no history returns { events: [] }', async () => {
  const contact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Empty`, phone: `9160${Date.now()}`.slice(0, 12) }),
  }).then((r) => r.json());

  const res = await fetch(`${baseUrl}/api/contacts/${contact.id}/timeline`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { events: [] });
});

test('2-4. mixed history across all 4 sources returns correctly-interleaved descending order; only sent/entered rows count', async () => {
  const phone = `9161${Date.now()}`.slice(0, 12);
  const contact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Mixed`, phone }),
  }).then((r) => r.json());
  const chat = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: contact.name, contact_id: contact.id }),
  }).then((r) => r.json());

  // Oldest -> newest: consent(-50m), message_in(-40m), flow entered(-30m),
  // message_out(-20m), broadcast sent(-10m). Expected timeline is the exact
  // reverse. A "flow_events, but not 'entered'" and a "broadcast_recipients,
  // but not 'sent'" row are also inserted to prove they're excluded.
  await pool.query(
    `insert into consent_events (client_id, contact_id, event, source, created_at)
     values ($1, $2, 'opted_in', 'chat_reply', now() - interval '50 minutes')`,
    [testClientId, contact.id]
  );
  await pool.query(
    `insert into messages (chat_id, client_id, direction, body, sent_at)
     values ($1, $2, 'in', 'Hi there', now() - interval '40 minutes')`,
    [chat.id, testClientId]
  );

  const flow = await fetch(`${baseUrl}/api/automation-flows`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Flow`, trigger: { type: 'keyword', value: 'hi' } }),
  }).then((r) => r.json());
  await pool.query(
    `insert into flow_events (client_id, contact_id, flow_id, event_type, created_at)
     values ($1, $2, $3, 'entered', now() - interval '30 minutes')`,
    [testClientId, contact.id, flow.id]
  );
  // Excluded: a step-level event, not an entry.
  await pool.query(
    `insert into flow_events (client_id, contact_id, flow_id, event_type, created_at)
     values ($1, $2, $3, 'message_sent', now() - interval '29 minutes')`,
    [testClientId, contact.id, flow.id]
  );

  await pool.query(
    `insert into messages (chat_id, client_id, direction, body, sent_at)
     values ($1, $2, 'out', 'How can I help?', now() - interval '20 minutes')`,
    [chat.id, testClientId]
  );

  const broadcast = await pool.query(
    `insert into broadcasts (client_id, title, template_name, status, param_mappings)
     values ($1, $2, $3, 'Completed', '{}') returning id`,
    [testClientId, `${SUITE_PREFIX}Campaign`, `${SUITE_PREFIX}template`]
  ).then((r) => r.rows[0]);
  const sentMessage = await pool.query(
    `insert into messages (chat_id, client_id, direction, body, sent_at)
     values ($1, $2, 'out', 'Broadcast body', now() - interval '10 minutes') returning id`,
    [chat.id, testClientId]
  ).then((r) => r.rows[0]);
  await pool.query(
    `insert into broadcast_recipients (broadcast_id, client_id, contact_id, message_id, status)
     values ($1, $2, $3, $4, 'sent')`,
    [broadcast.id, testClientId, contact.id, sentMessage.id]
  );
  // Excluded: a non-'sent' recipient row for the same broadcast.
  const otherContact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Skipped`, phone: `9162${Date.now()}`.slice(0, 12) }),
  }).then((r) => r.json());
  await pool.query(
    `insert into broadcast_recipients (broadcast_id, client_id, contact_id, status)
     values ($1, $2, $3, 'skipped')`,
    [broadcast.id, testClientId, otherContact.id]
  );

  const res = await fetch(`${baseUrl}/api/contacts/${contact.id}/timeline`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const { events } = await res.json();

  assert.equal(events.length, 5, 'exactly 5 real events — the excluded step-event and skipped-recipient rows must not appear');
  assert.deepEqual(
    events.map((e) => e.type),
    ['broadcast_sent', 'message_out', 'flow_entered', 'message_in', 'consent_changed'],
    'must be correctly interleaved across all 4 sources in real descending chronological order, not grouped by source'
  );

  // Real timestamp ordering, not just type-order luck.
  for (let i = 0; i < events.length - 1; i++) {
    assert.ok(new Date(events[i].at) >= new Date(events[i + 1].at), `event ${i} must not be older than event ${i + 1}`);
  }

  const broadcastEvent = events.find((e) => e.type === 'broadcast_sent');
  assert.equal(broadcastEvent.detail.title, `${SUITE_PREFIX}Campaign`);
  assert.equal(broadcastEvent.detail.templateName, `${SUITE_PREFIX}template`);
  const flowEvent = events.find((e) => e.type === 'flow_entered');
  assert.equal(flowEvent.detail.flowName, `${SUITE_PREFIX}Flow`);
  const consentEvent = events.find((e) => e.type === 'consent_changed');
  assert.equal(consentEvent.detail.event, 'opted_in');
  assert.equal(consentEvent.detail.source, 'chat_reply');
  const msgInEvent = events.find((e) => e.type === 'message_in');
  assert.equal(msgInEvent.detail.body, 'Hi there');
});

test('5. tenant isolation: another client\'s contact history never leaks in, and the endpoint 404s for a foreign contact id', async () => {
  const contact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}Isolated`, phone: `9163${Date.now()}`.slice(0, 12) }),
  }).then((r) => r.json());

  const res = await fetch(`${baseUrl}/api/contacts/${contact.id}/timeline`, { headers: authed(otherClientToken) });
  assert.equal(res.status, 404);
});

test('6. role gating: Agent can read (matches every other Contacts sub-route); unauthenticated is rejected; unknown contact 404s', async () => {
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

  const contact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}ForAgent`, phone: `9164${Date.now()}`.slice(0, 12) }),
  }).then((r) => r.json());

  const asAgent = await fetch(`${baseUrl}/api/contacts/${contact.id}/timeline`, { headers: authed(accepted.token) });
  assert.equal(asAgent.status, 200);

  const unauth = await fetch(`${baseUrl}/api/contacts/${contact.id}/timeline`);
  assert.equal(unauth.status, 401);

  const unknown = await fetch(`${baseUrl}/api/contacts/00000000-0000-0000-0000-000000000099/timeline`, { headers: authed(clientToken) });
  assert.equal(unknown.status, 404);
});
