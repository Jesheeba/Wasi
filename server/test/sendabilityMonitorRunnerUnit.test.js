// Sendability monitoring — pure unit coverage for the one load-bearing
// constraint the whole feature depends on: Layer 1 (registration) can never
// set wabas.sendable, no matter what it finds, because that heuristic
// (is_on_biz_app === false && code_verification_status !== 'VERIFIED') was
// floated as a "cannot send" rule but never confirmed (TNPSC registered
// successfully and code_verification_status stayed EXPIRED regardless of
// whether it could actually send). An unvalidated heuristic must not be
// able to override what the send probe (Layer 3) empirically finds.
//
// This test needs NO real database and NO real network call — refreshOne
// accepts injected { db, metaClient, auditLogRepo } stand-ins (see
// sendabilityMonitorRunner.js's own comment on why), so it runs anywhere,
// any time, in milliseconds. It does not even load dotenv or db/pool.js.
// The only real dependency is utils/encryption.js's decrypt/encrypt, which
// are pure local crypto against SERVER_SECRET — no DB, no network either.
//
// Real database/HTTP integration coverage (the admin route, the audit_log
// rows actually landing, GET /api/admin/health returning the new columns)
// lives separately in sendabilityLayers1And2Integration.test.js — run that
// one when you actually want to exercise the shared dev/prod database.
// dotenv only loads local env vars (SERVER_SECRET, for encrypt/decrypt
// below) into process.env — it opens no database connection and makes no
// network call, so this doesn't compromise "runs anywhere, any time." It's
// the same SERVER_SECRET every dev environment already needs for the rest
// of this suite to function at all.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sendabilityMonitorRunner = require('../src/services/sendabilityMonitorRunner');
const { encrypt } = require('../src/utils/encryption');

const FAKE_WABA = {
  id: 'fake-waba-row-id',
  client_id: 'fake-client-id',
  waba_id: 'fake-waba-id',
  phone_number_id: 'fake-phone-number-id',
  access_token_encrypted: encrypt('fake-token-never-sent-anywhere'),
};

// Records every call it receives; never touches a real database.
function makeFakeDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
}

// Records every call it receives; never touches a real metaClient module or
// the network — this IS the stub, not a wrapper around the real thing.
function makeFakeMetaClient(response) {
  const calls = [];
  return {
    calls,
    getPhoneNumberDetails: async (phoneNumberId, accessToken) => {
      calls.push({ phoneNumberId, accessToken });
      if (response.fail) throw new Error(response.failMessage || 'simulated Meta failure');
      return response;
    },
  };
}

function makeFakeAuditLogRepo() {
  const records = [];
  return {
    records,
    record: async (entry) => { records.push(entry); },
  };
}

test('refreshOne: a registration shape matching the unconfirmed "cannot send" rule never sets sendable', async () => {
  const db = makeFakeDb();
  const meta = makeFakeMetaClient({
    display_phone_number: '910000000000',
    is_on_biz_app: false, // exactly the floated rule's trigger condition
    code_verification_status: 'EXPIRED', // exactly the floated rule's trigger condition
    platform_type: 'CLOUD_API',
    status: 'CONNECTED',
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.ok, true);
  assert.equal(result.isOnBizApp, false);
  assert.equal(result.codeVerificationStatus, 'EXPIRED');

  // The load-bearing assertion. The returned result object has no `sendable`
  // key at all — refreshOne never computes one, structurally, not just by
  // convention — and the UPDATE it issued never references the sendable
  // columns either.
  assert.equal('sendable' in result, false, 'refreshOne must not even compute a sendable verdict, let alone return one');
  assert.equal(db.calls.length, 1, 'exactly one write — the registration/health UPDATE');
  const [{ sql }] = db.calls;
  assert.doesNotMatch(sql, /\bsendable\b/, 'the UPDATE statement must not touch any sendable* column, even when the data looks exactly like the unconfirmed "cannot send" shape');
  assert.match(sql, /registration_is_on_biz_app/);
  assert.match(sql, /health_status/);
});

test('refreshOne: an ordinary "looks fine" registration shape is handled identically — still no sendable column touched', async () => {
  const db = makeFakeDb();
  const meta = makeFakeMetaClient({ is_on_biz_app: true, code_verification_status: 'VERIFIED' });
  const audit = makeFakeAuditLogRepo();

  await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  const [{ sql }] = db.calls;
  assert.doesNotMatch(sql, /\bsendable\b/, 'the write path is identical regardless of what registration looks like — no branch anywhere sets sendable');
});

test('refreshOne: makes exactly one Meta call, read-only (getPhoneNumberDetails, a GET), per invocation', async () => {
  const db = makeFakeDb();
  const meta = makeFakeMetaClient({ is_on_biz_app: true, code_verification_status: 'VERIFIED' });
  const audit = makeFakeAuditLogRepo();

  await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(meta.calls.length, 1);
  assert.equal(meta.calls[0].phoneNumberId, FAKE_WABA.phone_number_id);
});

test('refreshOne: persists health_status verbatim, including a BUSINESS-level LIMITED entry, still without touching sendable', async () => {
  const db = makeFakeDb();
  const rawHealth = {
    entities: [
      { entity_type: 'BUSINESS', can_send_message: 'LIMITED', errors: [{ error_code: 141010, error_description: 'The Business has not passed business verification' }] },
    ],
  };
  const meta = makeFakeMetaClient({ health_status: rawHealth });
  const audit = makeFakeAuditLogRepo();

  await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  const [{ params, sql }] = db.calls;
  assert.doesNotMatch(sql, /\bsendable\b/);
  assert.deepEqual(JSON.parse(params[5]), rawHealth, 'health_status must be persisted exactly as Meta returned it');
});

test('refreshOne: a Meta failure never throws, never writes to db, still audits the failure — and still never mentions sendable', async () => {
  const db = makeFakeDb();
  const meta = makeFakeMetaClient({ fail: true, failMessage: 'Invalid OAuth access token' });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'Invalid OAuth access token');
  assert.equal(db.calls.length, 0, 'a failed Meta call must never reach the database write');
  assert.equal(audit.records.length, 1, 'the failure itself must still be audited — this is the exact gap that let the real outage run 26 hours undetected');
  assert.equal(audit.records[0].action, 'sendability_registration_check_failed');
});

test('refreshOne: a waba with no access token or phone_number_id is rejected before any dependency is touched', async () => {
  const db = makeFakeDb();
  const meta = makeFakeMetaClient({ is_on_biz_app: true });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne({ id: 'x' }, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.ok, false);
  assert.equal(meta.calls.length, 0);
  assert.equal(db.calls.length, 0);
  assert.equal(audit.records.length, 0);
});
