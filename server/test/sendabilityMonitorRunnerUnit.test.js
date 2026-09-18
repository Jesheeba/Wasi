// Sendability monitoring — pure unit coverage for the load-bearing
// constraints the whole feature depends on:
//   1. Layer 1 (registration) can never set wabas.sendable, no matter what
//      it finds — is_on_biz_app === false && code_verification_status !==
//      'VERIFIED' was floated as a "cannot send" rule but never confirmed
//      (TNPSC registered successfully and code_verification_status stayed
//      EXPIRED regardless of whether it could actually send). Only the
//      probe (Layer 3) may set it.
//   2. The probe runs unconditionally, every check, regardless of what
//      Layer 1/2 found or whether their own check even succeeded — today's
//      live run showed health_status AVAILABLE on every entity for the
//      account that actually cannot send (TNPSC), so skipping the probe
//      based on Layer 1/2's findings would defeat the one check that
//      catches that class of failure.
//   3. The probe classifies on error.code, never HTTP status (verified by
//      hand: Fortune/healthy = HTTP 404 code 132001, TNPSC/blocked = HTTP
//      403 code 200 — both OAuthException).
//   4. A probe response that isn't one of those two recognized codes sets
//      sendable = null and records exactly what came back — never guessed.
//   5. A probe that can't even reach Meta (network/timeout) must not touch
//      the sendable* columns at all — that's not evidence sendability
//      changed, just that this attempt failed.
//
// Needs NO real database and NO real network call — refreshOne accepts
// injected { db, metaClient, auditLogRepo } stand-ins (see
// sendabilityMonitorRunner.js's own comment on why), so this runs anywhere,
// any time, in milliseconds. It does not even load db/pool.js. The only
// real dependency is utils/encryption.js's decrypt/encrypt, which are pure
// local crypto against SERVER_SECRET — no DB, no network either.
//
// Real database/HTTP integration coverage lives separately in
// sendabilityLayers1And2Integration.test.js — run that one deliberately,
// when you want to exercise the shared dev/prod database.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sendabilityMonitorRunner = require('../src/services/sendabilityMonitorRunner');
const metaClient = require('../src/utils/metaClient');
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

// Records every call it receives; never touches the real metaClient module
// or the network — this IS the stub. `registration` and `probe` are
// controlled independently, since refreshOne now calls both unconditionally
// regardless of the other's outcome (requirement 2 above).
function makeFakeMetaClient({ registration, probe } = {}) {
  const registrationCalls = [];
  const probeCalls = [];
  return {
    registrationCalls,
    probeCalls,
    getPhoneNumberDetails: async (phoneNumberId, accessToken) => {
      registrationCalls.push({ phoneNumberId, accessToken });
      if (!registration) return {};
      if (registration.fail) throw new Error(registration.failMessage || 'simulated Meta failure');
      return registration;
    },
    probeSendability: async (phoneNumberId, accessToken) => {
      probeCalls.push({ phoneNumberId, accessToken });
      if (!probe) return { sendable: true, reason: null, code: null, errorData: null };
      if (probe.fail) throw new Error(probe.failMessage || 'simulated probe network failure');
      return probe;
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
    registration: {
      display_phone_number: '910000000000',
      is_on_biz_app: false, // exactly the floated rule's trigger condition
      code_verification_status: 'EXPIRED', // exactly the floated rule's trigger condition
      platform_type: 'CLOUD_API',
      status: 'CONNECTED',
    },
    probe: { sendable: true, reason: null, code: null, errorData: null },
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.ok, true);
  assert.equal(result.registration.ok, true);
  assert.equal(result.registration.isOnBizApp, false);
  assert.equal(result.registration.codeVerificationStatus, 'EXPIRED');

  // The load-bearing assertion: the registration write and the sendable
  // write are two DIFFERENT UPDATE statements, and the registration one —
  // even fed data matching the unconfirmed "cannot send" rule exactly —
  // never references any sendable* column.
  const registrationWrite = db.calls.find((c) => /registration_is_on_biz_app/.test(c.sql));
  assert.ok(registrationWrite, 'the registration UPDATE must have run');
  assert.doesNotMatch(registrationWrite.sql, /\bsendable\b/, 'the registration UPDATE must never touch any sendable* column, even when the data looks exactly like the unconfirmed "cannot send" shape');
});

test('refreshOne: the probe runs even when registration looks like the "cannot send" rule, and its own verdict is what sets sendable', async () => {
  const db = makeFakeDb();
  const meta = makeFakeMetaClient({
    registration: { is_on_biz_app: false, code_verification_status: 'EXPIRED' },
    probe: { sendable: true, reason: null, code: null, errorData: null }, // the probe disagrees with the heuristic — probe wins
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(meta.probeCalls.length, 1, 'the probe must run regardless of what registration found');
  assert.equal(result.probe.sendable, true, 'the empirical probe overrides the unconfirmed heuristic, not the other way around');
});

test('refreshOne: probe classifies on error.code, not HTTP status — the exact Fortune (healthy) shape verified by hand', async () => {
  const db = makeFakeDb();
  // Verified live 2026-09-18: Fortune returned HTTP 404 with code 132001.
  const meta = makeFakeMetaClient({
    probe: { sendable: true, reason: null, code: null, errorData: null },
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.probe.ok, true);
  assert.equal(result.probe.sendable, true);
  const sendableWrite = db.calls.find((c) => /\bsendable\s*=/.test(c.sql));
  assert.ok(sendableWrite);
  assert.equal(sendableWrite.params[0], true);
});

test('refreshOne: probe classifies the exact TNPSC (blocked) shape verified by hand — sendable false, code + reason + error_data captured', async () => {
  const db = makeFakeDb();
  // Verified live 2026-09-18: TNPSC returned HTTP 403, code 200, OAuthException.
  const meta = makeFakeMetaClient({
    probe: {
      sendable: false,
      reason: 'You do not have the necessary permission to send messages on behalf of this WhatsApp Business Account',
      code: 200,
      errorData: null,
    },
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.probe.sendable, false);
  assert.equal(result.probe.code, 200);
  const sendableWrite = db.calls.find((c) => /\bsendable\s*=/.test(c.sql));
  assert.equal(sendableWrite.params[0], false);
  assert.match(sendableWrite.params[1], /necessary permission/);
  assert.equal(sendableWrite.params[2], 200);

  const probeRecord = audit.records.find((r) => r.action === 'sendability_probed');
  assert.ok(probeRecord, 'a classified probe result must be audited as sendability_probed');
});

test('refreshOne: captures error_data alongside code and message — the Fortune error_data.details case', async () => {
  const db = makeFakeDb();
  const meta = makeFakeMetaClient({
    // Not the classified-as-healthy shape here on purpose — a hypothetical
    // rejection that carries error_data, to prove it round-trips into the
    // sendable_error_data column distinctly from sendable_reason/code.
    probe: {
      sendable: false,
      reason: '(#200) Some permission error',
      code: 200,
      errorData: { details: 'template name (__wasi_sendability_probe__) does not exist in en_US' },
    },
  });
  const audit = makeFakeAuditLogRepo();

  await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  const sendableWrite = db.calls.find((c) => /\bsendable\s*=/.test(c.sql));
  assert.match(sendableWrite.sql, /sendable_error_data/, 'the UPDATE must include the sendable_error_data column');
  assert.deepEqual(JSON.parse(sendableWrite.params[3]), { details: 'template name (__wasi_sendability_probe__) does not exist in en_US' });
});

test('refreshOne: an unrecognized probe response sets sendable=null, records exactly what came back, and raises sendability_unknown — never guessed', async () => {
  const db = makeFakeDb();
  const meta = makeFakeMetaClient({
    probe: {
      sendable: null,
      reason: 'Unexpected probe response: (#80007) Rate limit hit',
      code: 80007,
      errorData: { some: 'raw detail' },
    },
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.probe.sendable, null);
  const sendableWrite = db.calls.find((c) => /\bsendable\s*=/.test(c.sql));
  assert.equal(sendableWrite.params[0], null);
  assert.match(sendableWrite.params[1], /Rate limit hit/);
  assert.equal(sendableWrite.params[2], 80007);

  const unknownRecord = audit.records.find((r) => r.action === 'sendability_unknown');
  assert.ok(unknownRecord, 'an unrecognized response must be audited as sendability_unknown, distinct from a classified one');
});

test('refreshOne: a probe that never reaches Meta (network/timeout) does not touch the sendable* columns at all', async () => {
  const db = makeFakeDb();
  const meta = makeFakeMetaClient({
    registration: { is_on_biz_app: true, code_verification_status: 'VERIFIED' },
    probe: { fail: true, failMessage: 'fetch failed: ECONNRESET' },
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.probe.ok, false);
  assert.equal(result.probe.reason, 'fetch failed: ECONNRESET');
  // Registration's own write still happened — only the sendable write is
  // suppressed, and only because the probe itself never got a response.
  const sendableWrite = db.calls.find((c) => /\bsendable\s*=/.test(c.sql));
  assert.equal(sendableWrite, undefined, 'a probe that never got a response must never write to the sendable columns — that is not evidence sendability changed');

  const failRecord = audit.records.find((r) => r.action === 'sendability_probe_failed');
  assert.ok(failRecord, 'the probe failure itself must still be audited');
});

test('refreshOne: registration failing does not prevent the probe from running', async () => {
  const db = makeFakeDb();
  const meta = makeFakeMetaClient({
    registration: { fail: true, failMessage: 'expired token' },
    probe: { sendable: true, reason: null, code: null, errorData: null },
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.registration.ok, false);
  assert.equal(result.probe.ok, true);
  assert.equal(result.probe.sendable, true);
  assert.equal(meta.probeCalls.length, 1, 'an unrelated registration-check failure must never suppress the probe');
});

test('refreshOne: makes exactly one registration call and one probe call per invocation, both read/write against Meta only as documented (GET vs POST is metaClient\'s concern, not asserted here)', async () => {
  const db = makeFakeDb();
  const meta = makeFakeMetaClient({
    registration: { is_on_biz_app: true, code_verification_status: 'VERIFIED' },
    probe: { sendable: true, reason: null, code: null, errorData: null },
  });
  const audit = makeFakeAuditLogRepo();

  await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(meta.registrationCalls.length, 1);
  assert.equal(meta.probeCalls.length, 1);
  assert.equal(meta.registrationCalls[0].phoneNumberId, FAKE_WABA.phone_number_id);
  assert.equal(meta.probeCalls[0].phoneNumberId, FAKE_WABA.phone_number_id);
});

test('refreshOne: persists health_status verbatim, including a BUSINESS-level LIMITED entry, still without touching sendable from that write', async () => {
  const db = makeFakeDb();
  const rawHealth = {
    entities: [
      { entity_type: 'BUSINESS', can_send_message: 'LIMITED', errors: [{ error_code: 141010, error_description: 'The Business has not passed business verification' }] },
    ],
  };
  const meta = makeFakeMetaClient({
    registration: { health_status: rawHealth },
    probe: { sendable: true, reason: null, code: null, errorData: null },
  });
  const audit = makeFakeAuditLogRepo();

  await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  const registrationWrite = db.calls.find((c) => /health_status/.test(c.sql) && /registration_is_on_biz_app/.test(c.sql));
  assert.ok(registrationWrite);
  assert.doesNotMatch(registrationWrite.sql, /\bsendable\b/);
  assert.deepEqual(JSON.parse(registrationWrite.params[5]), rawHealth, 'health_status must be persisted exactly as Meta returned it');
});

// The tests above prove refreshOne correctly ACTS on whatever the probe
// returns. These prove the probe ITSELF — metaClient.probeSendability, the
// real classification code, not a stand-in for it — correctly reads Meta's
// actual response shapes. global.fetch is stubbed (this codebase's
// established convention, e.g. messagingTier.test.js), never a real network
// call, and still needs no database at all: metaClient.js has no dependency
// on db/pool.js.
function withFakeFetch(fakeResponse, fn) {
  const originalFetch = global.fetch;
  global.fetch = async () => fakeResponse;
  return Promise.resolve(fn()).finally(() => { global.fetch = originalFetch; });
}

test('metaClient.probeSendability: the exact Fortune (healthy) response verified by hand -> sendable true', async () => {
  // Real response captured 2026-09-18: HTTP 404, (#132001) template not found.
  await withFakeFetch({
    ok: false,
    status: 404,
    json: async () => ({
      error: {
        message: 'Template name does not exist in the translation',
        type: 'OAuthException',
        code: 132001,
        error_data: { messaging_product: 'whatsapp', details: 'template name (__wasi_sendability_probe__) does not exist in en_US' },
        fbtrace_id: 'A3rspSvhNvzDXhj_m3x-LY8',
      },
    }),
  }, async () => {
    const result = await metaClient.probeSendability('393354685298210', 'fake-token');
    assert.equal(result.sendable, true, 'HTTP status (404) must not be the signal — code 132001 is');
    assert.equal(result.code, null);
    assert.equal(result.reason, null);
  });
});

test('metaClient.probeSendability: the exact TNPSC (blocked) response verified by hand -> sendable false, code 200 captured', async () => {
  // Real response captured 2026-09-18: HTTP 403, (#200) OAuthException permission denied.
  await withFakeFetch({
    ok: false,
    status: 403,
    json: async () => ({
      error: {
        message: 'You do not have the necessary permission to send messages on behalf of this WhatsApp Business Account',
        type: 'OAuthException',
        code: 200,
        fbtrace_id: 'Az9VPzgDw080tYpho9Jv9TO',
      },
    }),
  }, async () => {
    const result = await metaClient.probeSendability('1222704867593433', 'fake-token');
    assert.equal(result.sendable, false, 'HTTP status (403) must not be the signal — code 200 is');
    assert.equal(result.code, 200);
    assert.match(result.reason, /necessary permission/);
  });
});

test('metaClient.probeSendability: an unrecognized code is never guessed into either bucket, and error_data is preserved', async () => {
  await withFakeFetch({
    ok: false,
    status: 400,
    json: async () => ({
      error: { message: 'Some other rejection', type: 'OAuthException', code: 131047, error_data: { details: 'some detail Meta sent' } },
    }),
  }, async () => {
    const result = await metaClient.probeSendability('some-phone-id', 'fake-token');
    assert.equal(result.sendable, null);
    assert.equal(result.code, 131047);
    assert.match(result.reason, /131047/);
    assert.deepEqual(result.errorData, { details: 'some detail Meta sent' });
  });
});

test('metaClient.probeSendability: a body with no Meta error object at all is also never guessed', async () => {
  await withFakeFetch({ ok: true, status: 200, json: async () => ({}) }, async () => {
    const result = await metaClient.probeSendability('some-phone-id', 'fake-token');
    assert.equal(result.sendable, null);
    assert.match(result.reason, /no Meta error object/);
  });
});

test('metaClient.probeSendability: uses the NANPA-reserved fictional recipient and the nonexistent probe template name', async () => {
  let capturedBody = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return { ok: false, status: 404, json: async () => ({ error: { code: 132001, message: 'not found' } }) };
  };
  try {
    await metaClient.probeSendability('some-phone-id', 'fake-token');
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(capturedBody.to, '12025550100');
  assert.equal(capturedBody.template.name, '__wasi_sendability_probe__');
});

test('refreshOne: a waba with no access token or phone_number_id is rejected before any dependency is touched', async () => {
  const db = makeFakeDb();
  const meta = makeFakeMetaClient({ registration: { is_on_biz_app: true } });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne({ id: 'x' }, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.ok, false);
  assert.equal(meta.registrationCalls.length, 0);
  assert.equal(meta.probeCalls.length, 0);
  assert.equal(db.calls.length, 0);
  assert.equal(audit.records.length, 0);
});
