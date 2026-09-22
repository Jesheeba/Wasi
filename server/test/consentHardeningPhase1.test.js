// Consent hardening Phase 1 (safety, no UI) — approved plan:
//   A. opted_out is sticky in consentRepo.recordEvent: an 'opted_in' event
//      against a contact whose CURRENT status is already 'opted_out' throws
//      ConsentBlockedError instead of silently overwriting it.
//   The inbound STOP path no longer fails silently: consentRepo.
//      recordOptOutDurable retries once, and on repeated failure writes a
//      durable failed_consent_writes row and raises a deduped alert_events
//      alert via the existing alertEventsRepo/alertNotifier infrastructure.
//   consent_events gains actor_type/actor_id/batch_id (migration 077),
//      populated by routes/contacts.js's POST /:id/consent today; nothing
//      else writes them yet (Phase 2/3 build the callers that will).
//
// Dedicated disposable test client, own SUITE_PREFIX — not shared with
// consentTracking.test.js, which already covers the pre-existing (unchanged)
// consent-gate/broadcast-skip/inbound-STOP-happy-path behavior; this file
// covers only what's new in Phase 1. Every Meta call is stubbed where one
// could be reached at all (it can't be, from any path this file exercises —
// noted per test).
//
// Test 5 (recordOptOutDurable's fully-failed path) stubs every side-effecting
// call — alertEventsRepo.findOpen/open/touch/markNotified,
// failedConsentWritesRepo.record, and alertNotifier.notify — by monkey-
// patching the exported functions on those required singleton modules
// (Node's require cache means this test's references and consentRepo.js's
// own internal references are the exact same objects). This is a deliberate
// correction: an earlier version of this test let recordOptOutDurable run
// for real against alert_events/failed_consent_writes on the shared
// database, relying on ALERT_EMAIL_TO/ALERT_WABA_ID being unset locally to
// keep alertNotifier's own send a safe no-op — but that's an environment
// assumption, not a guarantee, and the test still left real rows in two
// shared tables (cleaned up by hand afterward, twice, while this file was
// being debugged). The instruction was stubs only, no production writes,
// full stop — this file now satisfies that unconditionally, not just in
// whatever environment happens to have those env vars unset. Confirmed
// directly (not assumed) that nothing was actually delivered by the earlier
// version: RESEND_API_KEY/ALERT_EMAIL_TO/ALERT_WABA_ID are all unset in
// this repo's .env, and every real run's console output showed
// alertNotifier's own "would have sent" no-op line, never an actual send —
// but the DB rows themselves were real regardless, which is the part this
// rewrite actually fixes.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const consentRepo = require('../src/repositories/consentRepo');
const alertEventsRepo = require('../src/repositories/alertEventsRepo');
const failedConsentWritesRepo = require('../src/repositories/failedConsentWritesRepo');
const alertNotifier = require('../src/services/alertNotifier');
const contactsRepo = require('../src/repositories/contactsRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const automationFlowsRepo = require('../src/repositories/automationFlowsRepo');
const flowNodesRepo = require('../src/repositories/flowNodesRepo');
const flowEngine = require('../src/services/flowEngine');
const alertRunner = require('../src/services/alertRunner');

let server, baseUrl, clientToken, testClientId;

const SUITE_PREFIX = '__test_suite__consenthardp1_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function createContact(phone, name = 'Hardening Test Contact') {
  return fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name, phone }),
  }).then((r) => r.json());
}

async function setConsent(contactId, event, source = 'test_suite') {
  const res = await fetch(`${baseUrl}/api/contacts/${contactId}/consent`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ event, source }),
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
      email: `test-suite-consenthardp1-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
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

test('1. consentRepo.recordEvent: opted_out is sticky against a later opted_in, but every other transition still works', async () => {
  const contact = await contactsRepo.create(pool, testClientId, { name: 'x', phone: `91710${Date.now()}`.slice(0, 12) });

  // unknown -> opted_in: allowed.
  const afterOptIn = await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_in', source: 'test' });
  assert.equal(afterOptIn.opt_in_status, 'opted_in');

  // opted_in -> opted_out: always allowed (opting OUT is never blocked).
  const afterOptOut = await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_out', source: 'test' });
  assert.equal(afterOptOut.opt_in_status, 'opted_out');

  // opted_out -> opted_in: blocked.
  await assert.rejects(
    () => consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_in', source: 'test' }),
    (err) => {
      assert.ok(err instanceof consentRepo.ConsentBlockedError);
      assert.equal(err.code, 'opted_out_is_sticky');
      assert.match(err.message, /opted out/i);
      return true;
    }
  );

  // The blocked attempt must not have changed anything — status still
  // opted_out, and no new consent_events row from the blocked attempt.
  const stillOptedOut = await contactsRepo.findById(pool, testClientId, contact.id);
  assert.equal(stillOptedOut.opt_in_status, 'opted_out');
  const { rows: events } = await pool.query(
    'select event from consent_events where client_id = $1 and contact_id = $2 order by created_at asc',
    [testClientId, contact.id]
  );
  assert.deepEqual(events.map((e) => e.event), ['opted_in', 'opted_out'], 'the blocked opted_in attempt must not have written a third row');

  // opted_out -> opted_out again: allowed (re-recording the same state, e.g.
  // a second STOP, is not a re-opt-in and must never be blocked).
  const optedOutAgain = await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_out', source: 'test_again' });
  assert.equal(optedOutAgain.opt_in_status, 'opted_out');
});

test('2. POST /:id/consent: the blocked case is a clean 409, not a 500; actor_type/actor_id are recorded on every write', async () => {
  const contact = await createContact(`91711${Date.now()}`.slice(0, 12));

  const optIn = await setConsent(contact.id, 'opted_in');
  assert.equal(optIn.status, 201);
  const optOut = await setConsent(contact.id, 'opted_out');
  assert.equal(optOut.status, 201);

  const blocked = await setConsent(contact.id, 'opted_in');
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /opted out/i);

  // This test's requests all go through the client's own owner-level JWT
  // (registered via /api/auth/register, no team member involved) — the
  // route threads req.actorType/req.actorId, so every successful write here
  // must be actor_type = 'owner', actor_id = null (chats.js's own
  // established convention: null actor_id means "the account owner", not
  // "unknown").
  const { rows: events } = await pool.query(
    `select event, actor_type, actor_id from consent_events where client_id = $1 and contact_id = $2 order by created_at asc`,
    [testClientId, contact.id]
  );
  assert.deepEqual(events.map((e) => e.event), ['opted_in', 'opted_out']);
  for (const e of events) {
    assert.equal(e.actor_type, 'owner');
    assert.equal(e.actor_id, null);
  }
});

test('3. a flow set_opt_in node trying to re-opt-in an opted-out contact stalls (does not overwrite), and records why', async () => {
  const phone = `91712${Date.now()}`.slice(0, 12);
  const contact = await contactsRepo.create(pool, testClientId, { name: 'Flow Blocked Contact', phone });
  const chat = await chatsRepo.create(pool, testClientId, { name: contact.name, phone: contact.phone, contact_id: contact.id });
  await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_in', source: 'test' });
  await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_out', source: 'test' });

  const flow = await automationFlowsRepo.create(pool, testClientId, { name: `${SUITE_PREFIX}flow_${Date.now()}` });
  const node = await flowNodesRepo.create(pool, testClientId, flow.id, {
    type: 'action',
    config: { kind: 'set_opt_in', opt_in_event: 'opted_in' },
  });
  const withEntry = await automationFlowsRepo.update(pool, testClientId, flow.id, { entry_node_id: node.id, status: 'active' });
  assert.equal(withEntry.entry_node_id, node.id);

  // flowEngine always runs on the privileged `pool` (metaWebhook.js is its
  // only real caller) — same convention followed here, not req.db.
  await flowEngine.startFlow(pool, testClientId, contact, chat, withEntry);

  // The contact must still be opted_out — the flow node must NOT have
  // silently overwritten a real opt-out (the whole point of this change).
  const afterFlow = await contactsRepo.findById(pool, testClientId, contact.id);
  assert.equal(afterFlow.opt_in_status, 'opted_out', 'a flow must never re-opt-in a contact who has opted out');

  // runToRest's existing generic node-failure handling recorded why —
  // ConsentBlockedError propagates like any other action-node error.
  const { rows: flowEvents } = await pool.query(
    `select event_type, detail from flow_events where client_id = $1 and contact_id = $2 and flow_id = $3 and node_id = $4 order by created_at desc limit 1`,
    [testClientId, contact.id, flow.id, node.id]
  );
  assert.equal(flowEvents.length, 1);
  assert.equal(flowEvents[0].event_type, 'stalled');
  assert.equal(flowEvents[0].detail.code, 'opted_out_is_sticky');
  assert.match(flowEvents[0].detail.error, /opted out/i);
});

test('4. consentRepo.recordOptOutDurable: the ordinary case (write succeeds) behaves exactly like recordEvent, unchanged', async () => {
  const contact = await contactsRepo.create(pool, testClientId, { name: 'y', phone: `91713${Date.now()}`.slice(0, 12) });
  const result = await consentRepo.recordOptOutDurable(testClientId, contact.id, {
    source: 'inbound_stop_keyword',
    evidence: { body: 'STOP' },
  });
  assert.equal(result.opt_in_status, 'opted_out');

  const { rows: events } = await pool.query(
    'select event, source from consent_events where client_id = $1 and contact_id = $2',
    [testClientId, contact.id]
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'opted_out');
  assert.equal(events[0].source, 'inbound_stop_keyword');

  const { rows: failedWrites } = await pool.query(
    'select 1 from failed_consent_writes where client_id = $1 and contact_id = $2',
    [testClientId, contact.id]
  );
  assert.equal(failedWrites.length, 0, 'the durable fallback table must stay empty when the write succeeds');
});

test('5. consentRepo.recordOptOutDurable: a write that fails on every attempt calls the durable-write and alert functions correctly — fully stubbed, zero real alert_events/failed_consent_writes rows, zero real alertNotifier sends', async () => {
  const contact = await contactsRepo.create(pool, testClientId, { name: 'z', phone: `91714${Date.now()}`.slice(0, 12) });
  await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_in', source: 'test' }); // real, valid contact — this test simulates the WRITE failing, not a bad id

  // Simulates the main write genuinely failing (e.g. pool exhaustion, a
  // transient network blip) by making pool.connect() itself throw for the
  // first 2 calls — recordEvent's own `const client = await pool.connect()`
  // is the very first thing it does, outside its own try block, so this
  // fails it before any query runs. This part still touches the real
  // database (recordEvent's own write path is genuinely what's under test);
  // it's everything DOWNSTREAM of both attempts failing — the durable
  // fallback and the alert — that must never touch real infrastructure,
  // stubbed below.
  // Own restore, separate from the alert/durable-write stubs below —
  // pool.connect is stubbed and restored freshly around EACH
  // recordOptOutDurable call (each needs its own independent "fail the
  // first 2 attempts" counter), while the alert/durable-write stubs stay
  // installed across BOTH calls in this test and are restored exactly once
  // at the very end. A real, found-by-this-test bug in an earlier draft:
  // restoring every stub (including the alert ones) after the FIRST call
  // meant the SECOND call ran against the real alertEventsRepo/
  // failedConsentWritesRepo/alertNotifier — writing a real row to the
  // shared database despite this test's own purpose, and it was found only
  // because test 7 below then tripped over that leftover row.
  const originalConnect = pool.connect.bind(pool);
  function stubConnectToFailTwice() {
    let calls = 0;
    pool.connect = async (...args) => {
      calls += 1;
      if (calls <= 2) throw new Error('simulated: pool.connect failed (Phase 1 durable-fallback test)');
      return originalConnect(...args);
    };
  }
  function restoreConnect() {
    pool.connect = originalConnect;
  }

  // Monkey-patches the exact functions consentRepo.recordOptOutDurable
  // calls once both attempts fail — findOpen/open/touch/markNotified,
  // failedConsentWritesRepo.record, alertNotifier.notify — on the same
  // singleton module objects consentRepo.js itself required (Node's require
  // cache guarantees this test and consentRepo.js share one object per
  // module). No real row is ever written to alert_events or
  // failed_consent_writes, and alertNotifier.notify never attempts a real
  // send, regardless of what ALERT_EMAIL_TO/ALERT_WABA_ID are set to in
  // whatever environment this runs in — this is by construction, not by
  // relying on those env vars being unset. `openAlert` simulates
  // alert_events' own "is one already open" state across calls, in memory
  // only, so the dedup behavior (second failure touches, doesn't re-open)
  // is verifiable without a real table.
  const original = {
    findOpen: alertEventsRepo.findOpen,
    open: alertEventsRepo.open,
    touch: alertEventsRepo.touch,
    markNotified: alertEventsRepo.markNotified,
    record: failedConsentWritesRepo.record,
    notify: alertNotifier.notify,
  };
  const calls = { findOpen: 0, opened: [], touched: 0, markedNotified: 0, failedWrites: [], notified: [] };
  let openAlert = null;
  alertEventsRepo.findOpen = async (alertType, dedupKey) => {
    calls.findOpen += 1;
    return openAlert && openAlert.alert_type === alertType && openAlert.dedup_key === dedupKey ? openAlert : null;
  };
  alertEventsRepo.open = async (payload) => {
    calls.opened.push(payload);
    openAlert = { id: `fake-alert-${calls.opened.length}`, alert_type: payload.alertType, dedup_key: payload.dedupKey, ...payload };
    return openAlert;
  };
  alertEventsRepo.touch = async () => { calls.touched += 1; };
  alertEventsRepo.markNotified = async () => { calls.markedNotified += 1; };
  failedConsentWritesRepo.record = async (payload) => { calls.failedWrites.push(payload); };
  alertNotifier.notify = async (alertEvent) => { calls.notified.push(alertEvent); };

  function restoreAlertStubs() {
    alertEventsRepo.findOpen = original.findOpen;
    alertEventsRepo.open = original.open;
    alertEventsRepo.touch = original.touch;
    alertEventsRepo.markNotified = original.markNotified;
    failedConsentWritesRepo.record = original.record;
    alertNotifier.notify = original.notify;
  }

  let result;
  try {
    let firstResult;
    try {
      stubConnectToFailTwice();
      firstResult = await consentRepo.recordOptOutDurable(testClientId, contact.id, {
        source: 'inbound_stop_keyword',
        phone: contact.phone,
        evidence: { body: 'STOP', note: 'phase1 durable-fallback test (fully stubbed)' },
      });
    } finally {
      restoreConnect();
    }
    result = firstResult;

    assert.equal(result, null, 'a write that never succeeds must resolve to null, not throw out to the caller');
    const untouched = await contactsRepo.findById(pool, testClientId, contact.id);
    assert.equal(untouched.opt_in_status, 'opted_in', 'a failed opt-out write must not leave the contact in a half-changed state');

    assert.equal(calls.failedWrites.length, 1, 'the durable-write function must have been called exactly once');
    assert.equal(calls.failedWrites[0].event, 'opted_out');
    assert.equal(calls.failedWrites[0].source, 'inbound_stop_keyword');
    assert.equal(calls.failedWrites[0].contactId, contact.id);
    assert.match(calls.failedWrites[0].errorMessage, /simulated: pool\.connect failed/);

    assert.equal(calls.opened.length, 1, 'exactly one alert must have been opened');
    assert.equal(calls.opened[0].severity, 'critical');
    assert.equal(calls.opened[0].dedupKey, 'global');
    assert.equal(calls.opened[0].details.phone, contact.phone);
    assert.equal(calls.notified.length, 1, 'alertNotifier.notify must have been called exactly once — a stub call, never a real channel');
    assert.equal(calls.markedNotified, 1);

    // A second, unrelated-looking failure must NOT open a second alert —
    // deduped to one open alert for the whole failure class, same as
    // chatSlaLogsRepo.alertOnWriteFailure's own established behavior.
    // Verified purely against the in-memory openAlert state above, still
    // stubbed (not yet restored) — no real table involved.
    try {
      stubConnectToFailTwice();
      await consentRepo.recordOptOutDurable(testClientId, contact.id, { source: 'inbound_stop_keyword', evidence: {} });
    } finally {
      restoreConnect();
    }
    assert.equal(calls.opened.length, 1, 'still exactly one open() call total — the second failure must touch, not open a second alert');
    assert.ok(calls.touched >= 1, 'touch must have been called for the second failure');
    assert.equal(calls.notified.length, 1, 'no second real notify call for an already-open alert');
  } finally {
    restoreAlertStubs();
  }

  // Proof this test left nothing behind on the shared database, not an
  // assumption — the stubs above make this true by construction, but it's
  // asserted directly anyway since that's the whole point of this rewrite.
  // Scoped to THIS test's own contact id, not a generic error-text pattern —
  // a message-pattern match would also catch (and misreport as a failure)
  // unrelated historical rows genuinely resolved by earlier work on this
  // same file, since this table is a shared, never-deleted audit trail.
  const { rows: realAlerts } = await pool.query(
    `select 1 from alert_events where alert_type = 'consent_opt_out_write_failed' and details->>'contactId' = $1`,
    [contact.id]
  );
  assert.equal(realAlerts.length, 0, 'no real alert_events row may exist from this test');
  const { rows: realFailedWrites } = await pool.query(
    `select 1 from failed_consent_writes where contact_id = $1`,
    [contact.id]
  );
  assert.equal(realFailedWrites.length, 0, 'no real failed_consent_writes row may exist from this test');
});

test('6. consentRepo.recordOptOutDurable: when the durable write ALSO fails (a full DB outage), a real alert still fires via a DB-independent last-resort notify, and the full detail is console.error\'d', async () => {
  const contact = await contactsRepo.create(pool, testClientId, { name: 'w', phone: `91715${Date.now()}`.slice(0, 12) });

  const originalConnect = pool.connect.bind(pool);
  let connectCalls = 0;
  pool.connect = async (...args) => {
    connectCalls += 1;
    if (connectCalls <= 2) throw new Error('simulated: pool.connect failed (Phase 1 total-outage test)');
    return originalConnect(...args);
  };

  const original = {
    findOpen: alertEventsRepo.findOpen,
    record: failedConsentWritesRepo.record,
    notify: alertNotifier.notify,
    consoleError: console.error,
  };
  const calls = { notified: [], errors: [] };
  // Simulates the database being unreachable for BOTH the durable-write
  // insert and the DB-backed alert dedup check — the "full outage" case
  // this last-resort path exists for. alertNotifier.notify is still stubbed
  // (not left real) even here, per the same no-real-send rule as test 5 —
  // this test verifies it gets CALLED correctly, not that it actually sends.
  failedConsentWritesRepo.record = async () => { throw new Error('simulated: database unreachable (durable write)'); };
  alertEventsRepo.findOpen = async () => { throw new Error('simulated: database unreachable (alert dedup check)'); };
  alertNotifier.notify = async (alertEvent) => { calls.notified.push(alertEvent); };
  console.error = (...args) => { calls.errors.push(args); };

  let result;
  try {
    result = await consentRepo.recordOptOutDurable(testClientId, contact.id, {
      source: 'inbound_stop_keyword',
      phone: contact.phone,
      evidence: { body: 'STOP', note: 'phase1 total-outage test' },
    });
  } finally {
    pool.connect = originalConnect;
    alertEventsRepo.findOpen = original.findOpen;
    failedConsentWritesRepo.record = original.record;
    alertNotifier.notify = original.notify;
    console.error = original.consoleError;
  }

  assert.equal(result, null);

  // The last-resort notify must have fired directly, bypassing the DB
  // entirely — no alertEventsRepo.open/touch/markNotified call could have
  // supplied this shape, since findOpen itself was made to throw before
  // ever reaching them.
  assert.equal(calls.notified.length, 1, 'alertNotifier.notify must still have been called once, via the DB-independent fallback');
  assert.equal(calls.notified[0].severity, 'critical');
  assert.equal(calls.notified[0].alert_type, 'consent_opt_out_write_failed');
  assert.equal(calls.notified[0].details.clientId, testClientId);
  assert.equal(calls.notified[0].details.contactId, contact.id);
  assert.equal(calls.notified[0].details.phone, contact.phone);
  assert.equal(calls.notified[0].details.durableWriteSucceeded, false);

  // The unconditional last-resort console.error line must carry the full
  // detail (client, contact, phone, time) regardless of what else failed —
  // this is the "last resort" trace even if literally nothing else landed.
  const lastResortLine = calls.errors.find((args) => typeof args[0] === 'string' && args[0].includes('CONSENT OPT-OUT WRITE FAILED'));
  assert.ok(lastResortLine, 'the unconditional last-resort console.error line must have been printed');
  const detail = lastResortLine[1];
  assert.equal(detail.clientId, testClientId);
  assert.equal(detail.contactId, contact.id);
  assert.equal(detail.phone, contact.phone);
  assert.equal(detail.event, 'opted_out');
  assert.equal(detail.source, 'inbound_stop_keyword');
  assert.equal(detail.durableWriteSucceeded, false);
  assert.equal(detail.alerted, true, 'alerted must be true — the last-resort notify succeeded even though the DB-backed path did not');
  assert.ok(detail.at, 'a timestamp must be recorded');
});

test('7. alertRunner.replayFailedConsentWrites/checkPendingFailedConsentWrites: a pending row is retried, resolved on success, and the pending-count alert clears', async () => {
  // Safety check, not just documentation: replayFailedConsentWrites has no
  // per-client scoping (by design — it exists to clear ALL backlog across
  // every client), so this test only calls it after confirming the table
  // holds nothing but what this test is about to insert — same discipline
  // this project's own conventions require before touching a background-
  // runner-owned table on the shared database.
  // Scoped to UNRESOLVED rows — that's what replayFailedConsentWrites'
  // listPending() and countPending() actually operate on; a resolved row
  // left over from an earlier test/real usage (migration 078's own module
  // comment: resolved rows are meant to persist as history, not be
  // deleted) is inert and harmless to this precondition.
  const { rows: preExisting } = await pool.query(
    'select id, client_id, contact_id, error_message from failed_consent_writes where resolved_at is null'
  );
  assert.equal(preExisting.length, 0, `failed_consent_writes must have no UNRESOLVED rows before this test runs — found ${preExisting.length}, not safe to sweep with a global replay call: ${JSON.stringify(preExisting)}`);

  const contact = await contactsRepo.create(pool, testClientId, { name: 'replay test', phone: `91716${Date.now()}`.slice(0, 12) });
  assert.equal(contact.opt_in_status, 'unknown');

  await failedConsentWritesRepo.record({
    clientId: testClientId,
    contactId: contact.id,
    event: 'opted_out',
    source: 'inbound_stop_keyword',
    evidence: { body: 'STOP', note: 'phase1 replay test' },
    errorMessage: 'simulated original failure, now being replayed',
  });

  const beforeCandidates = await alertRunner.checkPendingFailedConsentWrites();
  assert.equal(beforeCandidates.length, 1);
  assert.ok(beforeCandidates[0].details.pendingCount >= 1);

  await alertRunner.replayFailedConsentWrites();

  // The contact must now actually be opted_out — the whole point of replay:
  // a customer who said STOP is no longer left reachable for marketing just
  // because the first attempt to record it failed.
  const replayed = await contactsRepo.findById(pool, testClientId, contact.id);
  assert.equal(replayed.opt_in_status, 'opted_out', 'replay must have actually applied the pending opt-out');

  const { rows: rowsAfter } = await pool.query(
    'select resolved_at from failed_consent_writes where client_id = $1 and contact_id = $2',
    [testClientId, contact.id]
  );
  assert.equal(rowsAfter.length, 1);
  assert.ok(rowsAfter[0].resolved_at, 'the row must be marked resolved after a successful replay');

  const afterCandidates = await alertRunner.checkPendingFailedConsentWrites();
  assert.equal(afterCandidates.length, 0, 'no candidates once every row is resolved — the ongoing alert would auto-resolve via reconcile()\'s own resolveStale');
});

test('8. alertRunner.replayFailedConsentWrites: a hypothetical pending opted_in row against a contact who has since opted out is resolved as moot, not retried forever', async () => {
  const { rows: preExisting } = await pool.query('select id from failed_consent_writes where resolved_at is null');
  assert.equal(preExisting.length, 0, 'failed_consent_writes must have no UNRESOLVED rows before this test runs — not safe to sweep with a global replay call otherwise');

  const contact = await contactsRepo.create(pool, testClientId, { name: 'moot replay test', phone: `91717${Date.now()}`.slice(0, 12) });
  await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_in', source: 'test' });
  await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_out', source: 'test' });

  // No real code path writes an 'opted_in' failed_consent_writes row today
  // — recordOptOutDurable only ever writes 'opted_out' — inserted directly
  // to exercise replayFailedConsentWrites' defensive ConsentBlockedError
  // branch, in case a future caller ever does.
  await failedConsentWritesRepo.record({
    clientId: testClientId, contactId: contact.id, event: 'opted_in', source: 'test_hypothetical',
    evidence: {}, errorMessage: 'hypothetical prior failure',
  });

  await alertRunner.replayFailedConsentWrites();

  const stillOptedOut = await contactsRepo.findById(pool, testClientId, contact.id);
  assert.equal(stillOptedOut.opt_in_status, 'opted_out', 'the real opt-out must not have been overwritten by the stale pending opted_in row');

  const { rows } = await pool.query(
    'select resolved_at from failed_consent_writes where client_id = $1 and contact_id = $2',
    [testClientId, contact.id]
  );
  assert.equal(rows.length, 1);
  assert.ok(rows[0].resolved_at, 'the row must be resolved (as moot), not left pending forever');
});
