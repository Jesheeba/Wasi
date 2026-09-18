// Sendability monitoring — pure unit coverage for the load-bearing
// constraints the whole feature depends on:
//   1. Layer 1 (registration) can never set wabas.sendable, no matter what
//      it finds — only the probe (Layer 3) and the combined verdict may.
//   2. The probe runs unconditionally, every check, regardless of what
//      Layer 1/2 found or whether their own check even succeeded.
//   3. The probe classifies on error.code, never HTTP status (verified by
//      hand: Fortune/healthy = HTTP 404 code 132001, TNPSC/blocked = HTTP
//      403 code 200 — both OAuthException).
//   4. An unrecognized probe response sets sendable = null and records
//      exactly what came back — never guessed.
//   5. A probe that can't even reach Meta must not touch the sendable*
//      columns at all.
//   6. THE PROBE ALONE IS NOT ENOUGH (found live 2026-09-18, first real
//      check cycle): three WABAs (GV Mart, Brainlit, RD Interlock Bricks)
//      passed the probe's permission check while Meta's health_status
//      reported them BLOCKED with 141006, a payment-method error the probe
//      cannot see. The combined verdict (wabas.sendable, written by
//      writeSendableVerdict/computeSendableVerdict) is false whenever
//      health_status shows any entity BLOCKED, even when the raw probe
//      result (wabas.probe_sendable) says true — see migration
//      076_wabas_sendable_verdict_split.js's header comment for the full
//      writeup. Both signals are preserved distinctly; neither is lost.
//   7. A registration/health fetch that fails, or that succeeds but omits
//      health_status this one time, must never overwrite a previously
//      good stored health_status with null — losing it would make
//      "genuinely never checked" indistinguishable from "checked before,
//      just not this time," and the combined verdict specifically depends
//      on that distinction (a null health_status means sendable=null, an
//      honest "unknown," never a guess).
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
  // Previously-stored state a real row would carry between cycles —
  // several tests below rely on these to prove coalesce/carry-over behavior.
  registration_is_on_biz_app: null,
  registration_code_verification_status: null,
  registration_platform_type: null,
  registration_phone_status: null,
  health_status: null,
};

// Records every call it receives; never touches a real database. Applies
// coalesce(new, existing) itself, same semantics as the real SQL, so tests
// can assert on the row's state after a write without a real Postgres.
function makeFakeDb(initialWaba) {
  const calls = [];
  let row = { ...initialWaba };
  return {
    calls,
    row: () => row,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/update wabas set\s+registration_is_on_biz_app/.test(sql)) {
        const [isOnBizApp, codeVerificationStatus, platformType, phoneStatus, checkedAt, healthStatusJson] = params;
        row = {
          ...row,
          registration_is_on_biz_app: isOnBizApp ?? row.registration_is_on_biz_app,
          registration_code_verification_status: codeVerificationStatus ?? row.registration_code_verification_status,
          registration_platform_type: platformType ?? row.registration_platform_type,
          registration_phone_status: phoneStatus ?? row.registration_phone_status,
          registration_checked_at: checkedAt,
          health_status: healthStatusJson ? JSON.parse(healthStatusJson) : row.health_status,
          health_status_checked_at: checkedAt,
        };
      } else if (/update wabas set\s+probe_sendable/.test(sql)) {
        const [sendable, reason, code, errorDataJson, checkedAt] = params;
        row = {
          ...row,
          probe_sendable: sendable, probe_reason: reason, probe_error_code: code,
          probe_error_data: errorDataJson ? JSON.parse(errorDataJson) : null,
          probe_checked_at: checkedAt,
        };
      } else if (/update wabas set sendable = /.test(sql)) {
        const [sendable, reason, checkedAt] = params;
        row = { ...row, sendable, sendable_reason: reason, sendable_checked_at: checkedAt };
      }
      return { rows: [] };
    },
  };
}

// Records every call it receives; never touches the real metaClient module
// or the network — this IS the stub. `registration` and `probe` are
// controlled independently, since refreshOne now calls both unconditionally
// regardless of the other's outcome.
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

// --------------------------------------------------------------------
// computeSendableVerdict — the core combining logic, tested directly and
// exhaustively, with zero I/O of any kind.
// --------------------------------------------------------------------

test('computeSendableVerdict: probe true, no BLOCKED entity -> sendable true, no reason', () => {
  const result = sendabilityMonitorRunner.computeSendableVerdict({
    probeSendable: true, probeReason: null,
    healthStatus: { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'AVAILABLE' }] },
  });
  assert.equal(result.sendable, true);
  assert.equal(result.reason, null);
});

test('computeSendableVerdict: probe true but a WABA entity is BLOCKED -> sendable false, reason names Health', () => {
  // The exact GV Mart / Brainlit / RD Interlock Bricks shape found live 2026-09-18.
  const result = sendabilityMonitorRunner.computeSendableVerdict({
    probeSendable: true, probeReason: null,
    healthStatus: { entities: [{ entity_type: 'WABA', can_send_message: 'BLOCKED', errors: [{ error_code: 141006, error_description: 'Payment method error' }] }] },
  });
  assert.equal(result.sendable, false);
  assert.match(result.reason, /^Health:/, 'reason must name which signal produced the verdict');
  assert.match(result.reason, /141006/);
});

test('computeSendableVerdict: a BLOCKED entity of ANY type counts, not just WABA', () => {
  const result = sendabilityMonitorRunner.computeSendableVerdict({
    probeSendable: true, probeReason: null,
    healthStatus: { entities: [{ entity_type: 'APP', can_send_message: 'BLOCKED', errors: [{ error_code: 999999 }] }] },
  });
  assert.equal(result.sendable, false);
  assert.match(result.reason, /^Health:/);
});

test('computeSendableVerdict: LIMITED (not BLOCKED) does not flip sendable to false', () => {
  const result = sendabilityMonitorRunner.computeSendableVerdict({
    probeSendable: true, probeReason: null,
    healthStatus: { entities: [{ entity_type: 'BUSINESS', can_send_message: 'LIMITED', errors: [{ error_code: 141010 }] }] },
  });
  assert.equal(result.sendable, true, 'only BLOCKED counts — LIMITED is a real but lesser restriction the user explicitly excluded');
});

test('computeSendableVerdict: probe false -> sendable false, reason names Probe, health_status is irrelevant', () => {
  const result = sendabilityMonitorRunner.computeSendableVerdict({
    probeSendable: false, probeReason: '(#200) Permission denied',
    healthStatus: { entities: [{ entity_type: 'WABA', can_send_message: 'AVAILABLE' }] }, // healthy — must not rescue a failing probe
  });
  assert.equal(result.sendable, false);
  assert.match(result.reason, /^Probe:/);
});

test('computeSendableVerdict: probe null (unrecognized) -> sendable null, reason names Probe', () => {
  const result = sendabilityMonitorRunner.computeSendableVerdict({ probeSendable: null, probeReason: 'Unexpected probe response: (#80007) Rate limit hit', healthStatus: null });
  assert.equal(result.sendable, null);
  assert.match(result.reason, /^Probe:/);
});

test('computeSendableVerdict: probe true but health_status is null (genuinely never checked) -> sendable null, reason names Health', () => {
  const result = sendabilityMonitorRunner.computeSendableVerdict({ probeSendable: true, probeReason: null, healthStatus: null });
  assert.equal(result.sendable, null, '"we could not see one of the two signals" is not "it is fine"');
  assert.match(result.reason, /^Health:/);
  assert.match(result.reason, /never successfully checked/);
});

// --------------------------------------------------------------------
// refreshOne — the orchestration: both sub-checks, then the combined verdict.
// --------------------------------------------------------------------

test('refreshOne: the exact GV Mart shape — probe passes but health_status is BLOCKED — combined sendable is false while the raw probe result is preserved as true', async () => {
  const db = makeFakeDb(FAKE_WABA);
  const meta = makeFakeMetaClient({
    registration: {
      health_status: { entities: [{ entity_type: 'WABA', can_send_message: 'BLOCKED', errors: [{ error_code: 141006, error_description: 'Payment method error' }] }] },
    },
    probe: { sendable: true, reason: null, code: null, errorData: null },
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.probe.sendable, true, 'the raw probe result must not be lost or altered');
  assert.equal(result.verdict.sendable, false, 'the combined verdict must reflect the health block the probe cannot see');
  assert.match(result.verdict.reason, /^Health:/);

  const finalRow = db.row();
  assert.equal(finalRow.probe_sendable, true, 'wabas.probe_sendable (raw) stays true — not overwritten');
  assert.equal(finalRow.sendable, false, 'wabas.sendable (combined) is false — the honest, trustworthy answer');
  assert.match(finalRow.sendable_reason, /141006/);
});

test('refreshOne: probe_* columns are the renamed ones — no write ever touches a column literally named sendable_error_code', async () => {
  const db = makeFakeDb(FAKE_WABA);
  const meta = makeFakeMetaClient({
    registration: { is_on_biz_app: true, code_verification_status: 'VERIFIED', health_status: { entities: [] } },
    probe: { sendable: false, reason: '(#200) Permission denied', code: 200, errorData: null },
  });
  const audit = makeFakeAuditLogRepo();

  await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  const probeWrite = db.calls.find((c) => /probe_sendable/.test(c.sql));
  assert.ok(probeWrite);
  assert.doesNotMatch(probeWrite.sql, /sendable_error_code/, 'the old pre-076 column name must never appear — it was renamed to probe_error_code');
  assert.match(probeWrite.sql, /probe_error_code/);
  assert.match(probeWrite.sql, /probe_error_data/);

  const verdictWrite = db.calls.find((c) => /update wabas set sendable = /.test(c.sql));
  assert.ok(verdictWrite);
  assert.doesNotMatch(verdictWrite.sql, /error_code|error_data/, 'the combined verdict deliberately carries no error_code/error_data of its own — sendable_reason plus probe_error_code/health_status is enough, no duplication');
});

test('refreshOne: a registration fetch that OMITS health_status this one time does not wipe a previously-good stored value, and the verdict uses the carried-over value', async () => {
  const wabaWithPriorHealth = {
    ...FAKE_WABA,
    health_status: { entities: [{ entity_type: 'WABA', can_send_message: 'BLOCKED', errors: [{ error_code: 141006 }] }] },
  };
  const db = makeFakeDb(wabaWithPriorHealth);
  const meta = makeFakeMetaClient({
    registration: { is_on_biz_app: true, code_verification_status: 'VERIFIED' }, // no health_status field at all this time
    probe: { sendable: true, reason: null, code: null, errorData: null },
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(wabaWithPriorHealth, { db, metaClient: meta, auditLogRepo: audit });

  assert.deepEqual(result.registration.healthStatus, wabaWithPriorHealth.health_status, 'the EFFECTIVE health_status returned must be the carried-over value, not null');
  assert.equal(result.verdict.sendable, false, 'the carried-over BLOCKED entity must still be honored by the verdict');

  const registrationWrite = db.calls.find((c) => /registration_is_on_biz_app/.test(c.sql));
  assert.match(registrationWrite.sql, /coalesce\(\$6, health_status\)/, 'the SQL itself must coalesce, not blindly overwrite, health_status');
  assert.equal(registrationWrite.params[5], null, 'the raw param passed is null (Meta omitted it) — coalesce is what protects the stored value, not the JS layer pretending Meta sent something it did not');
});

test('refreshOne: registration check failing outright still lets the verdict use the last known-good health_status', async () => {
  const wabaWithPriorHealth = {
    ...FAKE_WABA,
    health_status: { entities: [{ entity_type: 'WABA', can_send_message: 'AVAILABLE' }] },
  };
  const db = makeFakeDb(wabaWithPriorHealth);
  const meta = makeFakeMetaClient({
    registration: { fail: true, failMessage: 'expired token' },
    probe: { sendable: true, reason: null, code: null, errorData: null },
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(wabaWithPriorHealth, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.registration.ok, false);
  assert.equal(result.verdict.sendable, true, 'the probe passed and the carried-over health_status has nothing BLOCKED — verdict must not be null just because THIS cycle\'s registration call happened to fail');
});

test('refreshOne: probe passes and health_status has genuinely NEVER been checked -> combined verdict is null, not true', async () => {
  const db = makeFakeDb(FAKE_WABA); // FAKE_WABA.health_status is null — never checked
  const meta = makeFakeMetaClient({
    registration: { is_on_biz_app: true, code_verification_status: 'VERIFIED' }, // still no health_status in this response either
    probe: { sendable: true, reason: null, code: null, errorData: null },
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.verdict.sendable, null);
  assert.match(result.verdict.reason, /^Health:/);
  assert.match(result.verdict.reason, /never successfully checked/);
});

test('refreshOne: probe request failure (network/timeout) leaves the sendable verdict completely untouched — no write at all', async () => {
  const db = makeFakeDb({ ...FAKE_WABA, sendable: true, sendable_reason: null }); // a prior good verdict on the row
  const meta = makeFakeMetaClient({
    registration: { is_on_biz_app: true, code_verification_status: 'VERIFIED' },
    probe: { fail: true, failMessage: 'fetch failed: ECONNRESET' },
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.verdict, null, 'writeSendableVerdict must not even attempt to compute a verdict when the probe never got a response');
  const verdictWrite = db.calls.find((c) => /update wabas set sendable = /.test(c.sql));
  assert.equal(verdictWrite, undefined, 'no write to the sendable columns at all — a failed attempt is not evidence anything changed');
});

test('refreshOne: an unrecognized probe response still produces a combined verdict of null, and both audit actions fire', async () => {
  const db = makeFakeDb(FAKE_WABA);
  const meta = makeFakeMetaClient({
    registration: { is_on_biz_app: true, code_verification_status: 'VERIFIED', health_status: { entities: [] } },
    probe: { sendable: null, reason: 'Unexpected probe response: (#80007) Rate limit hit', code: 80007, errorData: { some: 'detail' } },
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.probe.sendable, null);
  assert.equal(result.verdict.sendable, null);
  assert.ok(audit.records.find((r) => r.action === 'sendability_unknown'), 'the probe\'s own unrecognized-response record must still fire');
  assert.ok(audit.records.find((r) => r.action === 'sendable_verdict_computed'), 'the combined-verdict record must also fire, even when the verdict itself is null');
});

test('refreshOne: every successful cycle writes THREE distinct audit_log actions (registration, probe, verdict)', async () => {
  const db = makeFakeDb(FAKE_WABA);
  const meta = makeFakeMetaClient({
    registration: { is_on_biz_app: true, code_verification_status: 'VERIFIED', health_status: { entities: [] } },
    probe: { sendable: true, reason: null, code: null, errorData: null },
  });
  const audit = makeFakeAuditLogRepo();

  await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  const actions = audit.records.map((r) => r.action).sort();
  assert.deepEqual(actions, ['sendability_probed', 'sendability_registration_checked', 'sendable_verdict_computed']);
});

test('refreshOne: registration failing does not prevent the probe or the verdict from running', async () => {
  const db = makeFakeDb(FAKE_WABA);
  const meta = makeFakeMetaClient({
    registration: { fail: true, failMessage: 'expired token' },
    probe: { sendable: true, reason: null, code: null, errorData: null },
  });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne(FAKE_WABA, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.registration.ok, false);
  assert.equal(result.probe.ok, true);
  assert.equal(meta.probeCalls.length, 1, 'an unrelated registration-check failure must never suppress the probe');
  // health_status is null on FAKE_WABA and registration failed too, so the
  // verdict is honestly null (never checked), not a crash.
  assert.equal(result.verdict.sendable, null);
});

test('refreshOne: makes exactly one registration call and one probe call per invocation', async () => {
  const db = makeFakeDb(FAKE_WABA);
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

test('refreshOne: a waba with no access token or phone_number_id is rejected before any dependency is touched', async () => {
  const db = makeFakeDb(FAKE_WABA);
  const meta = makeFakeMetaClient({ registration: { is_on_biz_app: true } });
  const audit = makeFakeAuditLogRepo();

  const result = await sendabilityMonitorRunner.refreshOne({ id: 'x' }, { db, metaClient: meta, auditLogRepo: audit });

  assert.equal(result.ok, false);
  assert.equal(meta.registrationCalls.length, 0);
  assert.equal(meta.probeCalls.length, 0);
  assert.equal(db.calls.length, 0);
  assert.equal(audit.records.length, 0);
});

// --------------------------------------------------------------------
// metaClient.probeSendability — the REAL classification code, not a
// stand-in for it. global.fetch is stubbed (this codebase's established
// convention), never a real network call, and still needs no database.
// --------------------------------------------------------------------

function withFakeFetch(fakeResponse, fn) {
  const originalFetch = global.fetch;
  global.fetch = async () => fakeResponse;
  return Promise.resolve(fn()).finally(() => { global.fetch = originalFetch; });
}

test('metaClient.probeSendability: the exact Fortune (healthy) response verified by hand -> sendable true', async () => {
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
