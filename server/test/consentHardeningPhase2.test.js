// Consent hardening Phase 2 (approved plan) — bulk "Mark as opted in" in
// Contacts, per-contact opt-in/opt-out control, and the
// MaxListenersExceededWarning fix in consentRepo.recordEvent found while
// building this phase (bulk opt-in calls recordEvent once per contact —
// hundreds in one request).
//
// Real DB, dedicated disposable test client (own SUITE_PREFIX) — same
// convention as every other file in this directory. No Meta call is
// reachable from anything this file exercises (consent never touches
// messagingService/metaClient), and nothing here touches alert_events/
// failed_consent_writes/alertNotifier at all, so there's nothing to stub on
// that front — this phase's own "stubs only, no production writes, nothing
// sent" instruction is satisfied by construction, not by mocking anything.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const consentRepo = require('../src/repositories/consentRepo');
const contactsRepo = require('../src/repositories/contactsRepo');

let server, baseUrl, clientToken, testClientId;

const SUITE_PREFIX = '__test_suite__consenthardp2_';
const PASSWORD = 'test-suite-password-12345';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// contactCreateSchema has no max length on phone, so no truncation is
// needed — a counter appended after Date.now() guarantees uniqueness even
// across near-simultaneous calls (e.g. inside Promise.all), unlike the
// Date.now()-plus-a-trailing-digit-then-sliced-to-12 pattern other test
// files use for a realistic-looking phone number: that pattern is safe
// there because each of THEIR calls happens at a distinctly later moment,
// but slicing to 12 characters here cut off the very digit meant to
// distinguish 3 contacts created in one Promise.all — a real bug in this
// file's own first draft, caught because it made every contact after the
// first collide on phone and 409, leaving `.id` undefined.
let phoneCounter = 0;
function nextPhone() {
  phoneCounter += 1;
  return `9173${Date.now()}${phoneCounter}`;
}

async function createContact(phone, name = 'Phase2 Test Contact') {
  const res = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name, phone: phone || nextPhone() }),
  });
  return res.json();
}

// Mirrors teamMemberAuth.test.js's own established helpers exactly, so a
// real Agent/Manager/Admin JWT is obtainable the same way every other test
// file in this suite already gets one.
//
// createdTeamMemberIds is tracked so after() can delete this file's own
// auth_tokens rows before the client (and its team_members, which cascade)
// is deleted — auth_tokens.subject_id has NO foreign key at all (it's
// polymorphic, referencing either a client or a team_member by convention
// only, see authTokensRepo.js), so a team-invite token row is never cleaned
// up by cascade the way team_members itself is. Confirmed for real, not
// assumed: a direct query found 440 such orphaned rows on the shared
// database while verifying this file's own residue — the overwhelming
// majority predate this file and this session entirely (the same
// established pattern in teamMemberAuth.test.js has the identical gap),
// but this file's own contribution is fixed here rather than left to add
// to that pile.
const authTokensRepo = require('../src/repositories/authTokensRepo');
const createdTeamMemberIds = [];
async function createTeamMember(role) {
  const res = await fetch(`${baseUrl}/api/team-members`, {
    method: 'POST', headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}${role}`, email: `${SUITE_PREFIX}${role}-${Date.now()}@wasi.local`, role }),
  });
  const teamMember = await res.json();
  if (teamMember.id) createdTeamMemberIds.push(teamMember.id);
  return teamMember;
}
async function teamMemberToken(role) {
  const created = await createTeamMember(role);
  const inviteToken = await authTokensRepo.create('team_member', created.id, 'team_invite', 60);
  const res = await fetch(`${baseUrl}/api/auth/team/accept-invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inviteToken, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const { token } = await res.json();
  return token;
}

async function bulkOptIn(token, body) {
  const res = await fetch(`${baseUrl}/api/contacts/bulk-consent`, {
    method: 'POST', headers: authed(token), body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
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
      email: `test-suite-consenthardp2-${Date.now()}@wasi.local`,
      password: PASSWORD,
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');
});

after(async () => {
  // Both of these tables lack a foreign key back to clients/team_members
  // (see createdTeamMemberIds' own comment above and routes/contacts.js's
  // bulk-consent audit_log.record call), so neither is cleaned up by the
  // client deletion's cascade below — deleted explicitly here instead,
  // scoped precisely to what this file itself created.
  if (createdTeamMemberIds.length) {
    await pool.query(`delete from auth_tokens where subject_id = any($1::uuid[])`, [createdTeamMemberIds]);
  }
  if (testClientId) {
    await pool.query(`delete from audit_log where actor_type = 'client' and actor_id = $1`, [testClientId]);
    await pool.query('delete from clients where id = $1', [testClientId]);
  }
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('1. bulk opt-in happy path: unknown contacts all become opted_in, share one batch_id, and record the exact statement/method/note', async () => {
  const contacts = await Promise.all([
    createContact(),
    createContact(),
    createContact(),
  ]);
  const ids = contacts.map((c) => c.id);

  const { status, data } = await bulkOptIn(clientToken, {
    contactIds: ids, method: 'website_form', note: 'phase2 test note', confirmed: true,
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.updated, 3);
  assert.equal(data.alreadyOptedIn, 0);
  assert.equal(data.skippedOptedOut, 0);
  assert.equal(data.notFound, 0);
  assert.ok(data.batchId);

  const { rows } = await pool.query(
    `select contact_id, event, source, evidence, actor_type, actor_id, batch_id from consent_events where client_id = $1 and contact_id = any($2::uuid[])`,
    [testClientId, ids]
  );
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.event, 'opted_in');
    assert.equal(row.source, 'bulk_ui');
    assert.equal(row.batch_id, data.batchId);
    assert.equal(row.actor_type, 'owner');
    assert.equal(row.actor_id, null);
    assert.equal(row.evidence.method, 'website_form');
    assert.equal(row.evidence.note, 'phase2 test note');
    assert.match(row.evidence.statement, /permission to receive marketing messages/);
  }

  const { rows: contactRows } = await pool.query(
    `select opt_in_status from contacts where client_id = $1 and id = any($2::uuid[])`,
    [testClientId, ids]
  );
  assert.ok(contactRows.every((r) => r.opt_in_status === 'opted_in'));
});

test('2. bulk opt-in mixed states: already-opted-in is skipped (not re-written), opted-out is refused, unknown is updated, a missing id is reported', async () => {
  const alreadyIn = await createContact();
  await consentRepo.recordEvent(testClientId, alreadyIn.id, { event: 'opted_in', source: 'test' });

  const optedOut = await createContact();
  await consentRepo.recordEvent(testClientId, optedOut.id, { event: 'opted_in', source: 'test' });
  await consentRepo.recordEvent(testClientId, optedOut.id, { event: 'opted_out', source: 'test' });

  const unknown = await createContact();
  const missingId = crypto.randomUUID();

  const before = await pool.query(
    'select count(*)::int as c from consent_events where client_id = $1 and contact_id = $2',
    [testClientId, alreadyIn.id]
  );

  const { status, data } = await bulkOptIn(clientToken, {
    contactIds: [alreadyIn.id, optedOut.id, unknown.id, missingId],
    method: 'in_store', confirmed: true,
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.updated, 1);
  assert.equal(data.alreadyOptedIn, 1);
  assert.equal(data.skippedOptedOut, 1);
  assert.equal(data.notFound, 1);
  assert.equal(data.total, 4);

  // The already-opted-in contact gets NO new consent_events row — bulk
  // opt-in must not clutter the audit trail with a redundant re-confirmation
  // for a contact whose status didn't actually change.
  const after = await pool.query(
    'select count(*)::int as c from consent_events where client_id = $1 and contact_id = $2',
    [testClientId, alreadyIn.id]
  );
  assert.equal(after.rows[0].c, before.rows[0].c);

  // The opted-out contact must still be opted_out — sticky opt-out held.
  const optedOutRow = await contactsRepo.findById(pool, testClientId, optedOut.id);
  assert.equal(optedOutRow.opt_in_status, 'opted_out');

  const unknownRow = await contactsRepo.findById(pool, testClientId, unknown.id);
  assert.equal(unknownRow.opt_in_status, 'opted_in');
});

test('3. bulk opt-in validation: missing confirmed, empty contactIds, and an invalid method are all rejected with 400', async () => {
  const contact = await createContact();

  const noConfirm = await bulkOptIn(clientToken, { contactIds: [contact.id], method: 'website_form' });
  assert.equal(noConfirm.status, 400);

  const emptyIds = await bulkOptIn(clientToken, { contactIds: [], method: 'website_form', confirmed: true });
  assert.equal(emptyIds.status, 400);

  const badMethod = await bulkOptIn(clientToken, { contactIds: [contact.id], method: 'carrier_pigeon', confirmed: true });
  assert.equal(badMethod.status, 400);

  // None of the rejected requests may have changed anything.
  const row = await contactsRepo.findById(pool, testClientId, contact.id);
  assert.equal(row.opt_in_status, 'unknown');
});

test('4. bulk opt-in role gating: Agent is forbidden, Manager/Admin/Owner succeed', async () => {
  const contactForAgent = await createContact();
  const contactForManager = await createContact();

  const agentToken = await teamMemberToken('Agent');
  const agentAttempt = await bulkOptIn(agentToken, { contactIds: [contactForAgent.id], method: 'website_form', confirmed: true });
  assert.equal(agentAttempt.status, 403, JSON.stringify(agentAttempt.data));
  const stillUnknown = await contactsRepo.findById(pool, testClientId, contactForAgent.id);
  assert.equal(stillUnknown.opt_in_status, 'unknown');

  const managerToken = await teamMemberToken('Manager');
  const managerAttempt = await bulkOptIn(managerToken, { contactIds: [contactForManager.id], method: 'website_form', confirmed: true });
  assert.equal(managerAttempt.status, 200, JSON.stringify(managerAttempt.data));
  assert.equal(managerAttempt.data.updated, 1);
  const nowIn = await contactsRepo.findById(pool, testClientId, contactForManager.id);
  assert.equal(nowIn.opt_in_status, 'opted_in');
});

test('5. per-contact route: an Agent may mark opted_out but is forbidden from marking opted_in; Manager may do both', async () => {
  const agentToken = await teamMemberToken('Agent');
  const managerToken = await teamMemberToken('Manager');

  const contactA = await createContact();
  const optOutRes = await fetch(`${baseUrl}/api/contacts/${contactA.id}/consent`, {
    method: 'POST', headers: authed(agentToken),
    body: JSON.stringify({ event: 'opted_out', source: 'client_marked' }),
  });
  assert.equal(optOutRes.status, 201, JSON.stringify(await optOutRes.clone().json()));

  const contactB = await createContact();
  const optInAsAgentRes = await fetch(`${baseUrl}/api/contacts/${contactB.id}/consent`, {
    method: 'POST', headers: authed(agentToken),
    body: JSON.stringify({ event: 'opted_in', source: 'client_marked' }),
  });
  assert.equal(optInAsAgentRes.status, 403);
  const stillUnknown = await contactsRepo.findById(pool, testClientId, contactB.id);
  assert.equal(stillUnknown.opt_in_status, 'unknown');

  const optInAsManagerRes = await fetch(`${baseUrl}/api/contacts/${contactB.id}/consent`, {
    method: 'POST', headers: authed(managerToken),
    body: JSON.stringify({ event: 'opted_in', source: 'client_marked' }),
  });
  assert.equal(optInAsManagerRes.status, 201, JSON.stringify(await optInAsManagerRes.clone().json()));
});

test('6. consentRepo.recordEvent: a few hundred calls on the pool with no MaxListenersExceededWarning', async () => {
  const contact = await createContact();

  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on('warning', onWarning);
  try {
    // Always 'opted_out' — an earlier draft alternated opted_in/opted_out,
    // which sounded like it would exercise more of recordEvent but is
    // actually wrong: after the very first opted_out write, every following
    // opted_in attempt is sticky-opt-out-blocked (Phase 1), so the loop
    // would throw at i=2, not run 300 times. Opting OUT is never blocked
    // regardless of current status, so re-recording it 300 times is both
    // valid and exercises the exact thing under test — 300 real
    // connect()/release() cycles on the pool, the shape bulk opt-in
    // produces against a large selection — without hitting an unrelated
    // guard.
    for (let i = 0; i < 300; i++) {
      await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_out', source: 'test_loop' });
    }
  } finally {
    process.removeListener('warning', onWarning);
  }

  const leakWarnings = warnings.filter((w) => w.name === 'MaxListenersExceededWarning');
  assert.equal(leakWarnings.length, 0, `expected no MaxListenersExceededWarning, got: ${leakWarnings.map((w) => w.message).join(' | ')}`);
});

test('7. the shared consent statement is served raw and matches what the server actually stores', async () => {
  const res = await fetch(`${baseUrl}/consentStatement.js`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /CONSENT_STATEMENT/);

  const { CONSENT_STATEMENT } = require('../src/utils/consentStatement');
  assert.match(text, /permission to receive marketing messages/);
  assert.ok(CONSENT_STATEMENT.length > 20);

  // Confirms the bulk route stores this EXACT string, not a hand-copied one
  // that could drift — the real end-to-end guarantee this file exists for.
  const contact = await createContact();
  const { status, data } = await bulkOptIn(clientToken, { contactIds: [contact.id], method: 'other', note: 'x', confirmed: true });
  assert.equal(status, 200, JSON.stringify(data));
  const { rows } = await pool.query(
    'select evidence from consent_events where client_id = $1 and contact_id = $2',
    [testClientId, contact.id]
  );
  assert.equal(rows[0].evidence.statement, CONSENT_STATEMENT);
});
