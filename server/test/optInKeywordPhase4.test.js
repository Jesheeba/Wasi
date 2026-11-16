// Consent hardening Phase 4 (START keyword half) - approved in CLAUDE.md's
// Known Gaps, built after a real support case: a client's contact sent
// STOP then START, and the system left them stuck opted_out forever -
// confirmed live that NO caller (manual UI, bulk, CSV, flow) could ever
// lift a sticky opt-out, there was no override anywhere.
//
// Covers:
//   1. optOutKeywords.isOptInMessage - whole-message matching, same
//      discipline as isOptOutMessage.
//   2. consentRepo.recordEvent's new allowOverrideOptOut param - the ONE
//      way past the sticky-opt-out guard, and that every other caller
//      (omitting it) stays blocked exactly as before.
//   3. consentRepo.recordOptInDurable - the ordinary success path.
//   4. End-to-end via the real webhook: STOP then START flips the contact
//      all the way back to opted_in, two consent_events rows.
//   5. alertRunner.replayFailedConsentWrites: a pending START-sourced
//      opted_in row replays successfully (gets the override); a pending
//      opted_in row under any OTHER source still does not (the sticky
//      guarantee must hold for every row regardless of how it got there,
//      not just by event type).
//   6. alertRunner.replayFailedConsentWrites: a stale pending STOP row
//      from before a later real START must not overwrite the newer
//      opted_in state (the Phase 4 note in CLAUDE.md, now implemented).
//
// Dedicated disposable test client, own SUITE_PREFIX. Every Meta call is
// unreachable from any path this file exercises (same as
// consentHardeningPhase1.test.js) - the WABA here is never given a real
// access token.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const contactsRepo = require('../src/repositories/contactsRepo');
const consentRepo = require('../src/repositories/consentRepo');
const failedConsentWritesRepo = require('../src/repositories/failedConsentWritesRepo');
const alertRunner = require('../src/services/alertRunner');
const { isOptInMessage } = require('../src/utils/optOutKeywords');

let server, baseUrl, testClientId;

const SUITE_PREFIX = '__test_suite__optinphase4_';
const TEST_WABA_ID = 'test_suite_optinphase4_waba_id';

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
      email: `test-suite-optinphase4-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  testClientId = registered.client?.id;
  assert.ok(testClientId, 'dedicated test client registration must succeed');

  // Needed only for the webhook end-to-end test - never given a real
  // access token, so it can never actually send.
  await wabasRepo.upsertForClient(testClientId, { waba_id: TEST_WABA_ID, status: 'connected' });
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('1. isOptInMessage: matches whole-message START/equivalents, not a substring, same discipline as isOptOutMessage', () => {
  assert.equal(isOptInMessage('START'), true);
  assert.equal(isOptInMessage('start'), true);
  assert.equal(isOptInMessage('  Start.  '), true);
  assert.equal(isOptInMessage('subscribe'), true);
  assert.equal(isOptInMessage('yes'), true);
  // Must not match a message that merely CONTAINS the word.
  assert.equal(isOptInMessage('please start sending me offers'), false);
  assert.equal(isOptInMessage('hello'), false);
  assert.equal(isOptInMessage(''), false);
  assert.equal(isOptInMessage(null), false);
});

test('2. consentRepo.recordEvent: allowOverrideOptOut lifts a sticky opt-out; every other caller (omitting it) stays blocked', async () => {
  const contact = await contactsRepo.create(pool, testClientId, { name: 'override test', phone: `91720${Date.now()}`.slice(0, 12) });
  await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_in', source: 'test' });
  await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_out', source: 'test' });

  // Unchanged behavior: a normal opted_in attempt (no override) is still blocked.
  await assert.rejects(
    () => consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_in', source: 'bulk_opt_in' }),
    consentRepo.ConsentBlockedError
  );

  // The one path that may: allowOverrideOptOut: true.
  const result = await consentRepo.recordEvent(testClientId, contact.id, {
    event: 'opted_in', source: 'inbound_start_keyword', allowOverrideOptOut: true,
  });
  assert.equal(result.opt_in_status, 'opted_in');
});

test('3. consentRepo.recordOptInDurable: the ordinary case lifts a sticky opt-out and writes a consent_events row', async () => {
  const contact = await contactsRepo.create(pool, testClientId, { name: 'durable opt-in test', phone: `91721${Date.now()}`.slice(0, 12) });
  await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_in', source: 'test' });
  await consentRepo.recordEvent(testClientId, contact.id, { event: 'opted_out', source: 'test' });

  const result = await consentRepo.recordOptInDurable(testClientId, contact.id, {
    source: 'inbound_start_keyword',
    evidence: { body: 'START' },
  });
  assert.equal(result.opt_in_status, 'opted_in');

  const { rows: events } = await pool.query(
    'select event, source from consent_events where client_id = $1 and contact_id = $2 order by created_at asc',
    [testClientId, contact.id]
  );
  assert.equal(events.length, 3); // opted_in (test), opted_out (test), opted_in (START)
  assert.equal(events[2].event, 'opted_in');
  assert.equal(events[2].source, 'inbound_start_keyword');

  const { rows: failedWrites } = await pool.query(
    'select 1 from failed_consent_writes where client_id = $1 and contact_id = $2', [testClientId, contact.id]
  );
  assert.equal(failedWrites.length, 0, 'the durable fallback table must stay empty when the write succeeds');
});

test('4. end-to-end via the real webhook: STOP then START flips the contact all the way back to opted_in', async () => {
  const phone = `91722${Date.now()}`.slice(0, 12);

  async function sendInboundText(text, wamidSuffix) {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: TEST_WABA_ID,
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '917339561632', phone_number_id: 'test_suite_optinphase4_phone_id' },
            contacts: [{ wa_id: phone, profile: { name: 'Stop Then Start Sender' } }],
            messages: [{ from: phone, id: `wamid.${wamidSuffix}_${Date.now()}`, type: 'text', text: { body: text }, timestamp: '1786973300' }],
          },
        }],
      }],
    };
    const body = JSON.stringify(payload);
    const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
    return fetch(`${baseUrl}/webhooks/meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
      body,
    });
  }

  const stopRes = await sendInboundText('STOP', 'stop');
  assert.equal(stopRes.status, 200);

  const { rows: afterStop } = await pool.query('select * from contacts where client_id = $1 and phone = $2', [testClientId, phone]);
  assert.equal(afterStop.length, 1);
  assert.equal(afterStop[0].opt_in_status, 'opted_out');

  const startRes = await sendInboundText('START', 'start');
  assert.equal(startRes.status, 200);

  const { rows: afterStart } = await pool.query('select * from contacts where client_id = $1 and phone = $2', [testClientId, phone]);
  assert.equal(afterStart[0].opt_in_status, 'opted_in', 'the real fix this feature is about - START must lift the opt-out');
  assert.ok(afterStart[0].opt_in_at);

  const { rows: events } = await pool.query(
    'select event, source from consent_events where client_id = $1 and contact_id = $2 order by created_at asc',
    [testClientId, afterStop[0].id]
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.event), ['opted_out', 'opted_in']);
  assert.equal(events[1].source, 'inbound_start_keyword');
});

test('5. alertRunner.replayFailedConsentWrites: a pending START-sourced opted_in row replays successfully; any other source stays blocked', async () => {
  const { rows: preExisting } = await pool.query('select id from failed_consent_writes where resolved_at is null');
  assert.equal(preExisting.length, 0, 'failed_consent_writes must have no UNRESOLVED rows before this test runs - not safe to sweep with a global replay call otherwise');

  // Case A: a real START-sourced pending row must replay and actually lift the opt-out.
  const contactA = await contactsRepo.create(pool, testClientId, { name: 'replay start test', phone: `91723${Date.now()}`.slice(0, 12) });
  await consentRepo.recordEvent(testClientId, contactA.id, { event: 'opted_in', source: 'test' });
  await consentRepo.recordEvent(testClientId, contactA.id, { event: 'opted_out', source: 'test' });
  await failedConsentWritesRepo.record({
    clientId: testClientId, contactId: contactA.id, event: 'opted_in', source: 'inbound_start_keyword',
    evidence: { body: 'START' }, errorMessage: 'simulated original failure, now being replayed',
  });

  // Case B: a pending opted_in row under a DIFFERENT source must stay
  // blocked on replay - the sticky guarantee has to hold for every row
  // regardless of how it got there, not just by checking event === 'opted_in'.
  const contactB = await contactsRepo.create(pool, testClientId, { name: 'replay non-start test', phone: `91724${Date.now()}`.slice(0, 12) });
  await consentRepo.recordEvent(testClientId, contactB.id, { event: 'opted_in', source: 'test' });
  await consentRepo.recordEvent(testClientId, contactB.id, { event: 'opted_out', source: 'test' });
  await failedConsentWritesRepo.record({
    clientId: testClientId, contactId: contactB.id, event: 'opted_in', source: 'bulk_opt_in',
    evidence: {}, errorMessage: 'hypothetical prior failure, wrong source',
  });

  await alertRunner.replayFailedConsentWrites();

  const replayedA = await contactsRepo.findById(pool, testClientId, contactA.id);
  assert.equal(replayedA.opt_in_status, 'opted_in', 'a genuine START-sourced pending write must be applied on replay');

  const replayedB = await contactsRepo.findById(pool, testClientId, contactB.id);
  assert.equal(replayedB.opt_in_status, 'opted_out', 'a non-START-sourced opted_in row must stay blocked even on replay');

  const { rows: rowsAfter } = await pool.query(
    'select contact_id, resolved_at from failed_consent_writes where client_id = $1 and contact_id = any($2::uuid[])',
    [testClientId, [contactA.id, contactB.id]]
  );
  assert.equal(rowsAfter.length, 2);
  assert.ok(rowsAfter.every((r) => r.resolved_at), 'both rows resolved - A because it succeeded, B as moot (blocked, same as a stale row)');
});

test('6. alertRunner.replayFailedConsentWrites: a stale pending STOP row from before a later real START must not overwrite the newer opted_in state', async () => {
  const { rows: preExisting } = await pool.query('select id from failed_consent_writes where resolved_at is null');
  assert.equal(preExisting.length, 0, 'failed_consent_writes must have no UNRESOLVED rows before this test runs');

  const contact = await contactsRepo.create(pool, testClientId, { name: 'stale stop replay test', phone: `91725${Date.now()}`.slice(0, 12) });

  // The stale STOP "failure" happened first...
  await failedConsentWritesRepo.record({
    clientId: testClientId, contactId: contact.id, event: 'opted_out', source: 'inbound_stop_keyword',
    evidence: { body: 'STOP' }, errorMessage: 'simulated original failure from before the START below',
  });
  // ...but a newer, real START succeeded afterward (this is the exact
  // CLAUDE.md Phase 4 note scenario: "must never apply a stored opt-out on
  // top of a newer opt-in... compare event times before replaying").
  await consentRepo.recordOptInDurable(testClientId, contact.id, { source: 'inbound_start_keyword', evidence: { body: 'START' } });

  await alertRunner.replayFailedConsentWrites();

  const afterReplay = await contactsRepo.findById(pool, testClientId, contact.id);
  assert.equal(afterReplay.opt_in_status, 'opted_in', 'the stale STOP must not have overwritten the newer, real START');

  const { rows } = await pool.query(
    'select resolved_at from failed_consent_writes where client_id = $1 and contact_id = $2',
    [testClientId, contact.id]
  );
  assert.equal(rows.length, 1);
  assert.ok(rows[0].resolved_at, 'the stale row must be resolved as moot, not left pending forever');
});
