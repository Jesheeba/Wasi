// Sendability monitoring — all three layers.
// Built after a real 26-hour undetected outage (TNPSC Mentors, 2026-09-18) —
// see migration 074_wabas_sendability.js's header comment for the full
// context and why this is three layers, not one.
//
// Layer 3 (the send probe) was approved 2026-09-18 after validating by hand
// against both a known-good account (Fortune: HTTP 404, code 132001) and the
// known-bad one (TNPSC: HTTP 403, code 200) — see metaClient.probeSendability's
// own header comment. Today's live run made it MORE important, not less:
// health_status came back AVAILABLE on every entity for TNPSC (the account
// that cannot send) while correctly flagging real 141006 payment errors on
// three other clients — proof health_status catches one class of problem and
// misses another, and the probe is the only check that tests the thing that
// actually matters (can a real message go out). So the probe runs for EVERY
// connected WABA on EVERY check, unconditionally — never skipped because
// health_status looked fine, never skipped because Layer 1's registration
// check flagged something, and never skipped just because Layer 1/2's own
// Meta call failed (an unrelated read failure must not silently suppress the
// one check that catches billing).
//
// Only checkSendabilityProbe ever writes wabas.sendable/sendable_reason/
// sendable_error_code/sendable_error_data/sendable_checked_at.
// checkRegistrationAndHealth (Layer 1+2) writes only its own
// registration_*/health_status* columns — is_on_biz_app === false &&
// code_verification_status !== 'VERIFIED' was floated as a "definitely
// can't send" rule, but it was never confirmed (TNPSC registered
// successfully and code_verification_status stayed EXPIRED regardless of
// whether it could actually send), so it must never be able to override
// what the probe empirically finds.
//
// Same fetch+persist shape as messagingTierRefreshRunner.js (own file, own
// interval, staleness-gated tick, refreshOne/refreshNow split for the admin
// "check now" button) — see that file's header comment for why this kind of
// job isn't folded into alertRunner.js's pure check-then-alert shape. No
// alertRunner wiring yet, by direct instruction — watch one real cycle
// after this deploys before turning on any alerting against the new verdict.
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');

// pool/auditLogRepo are required LAZILY (inside functions, never at module
// scope) so this file can be `require`d by a pure unit test — see
// sendabilityMonitorRunnerUnit.test.js — without transitively loading
// db/pool.js, whose own module-scope guard (assertNotProductionDatabase)
// would otherwise throw the moment this file is imported, even for a test
// that injects stub replacements and never touches the database. Real
// callers (refreshNow/tick/the admin route) get the exact same real pool/
// auditLogRepo as before — this changes WHEN they're required, not WHAT.
function getPool() { return require('../db/pool').pool; }
function getAuditLogRepo() { return require('../repositories/auditLogRepo'); }

const TICK_MS = 60 * 60 * 1000; // hourly tick, same cadence as messagingTierRefreshRunner
const STALE_AFTER_MS = 4 * 60 * 60 * 1000; // 4h — see the approved plan's cadence reasoning; both layers refresh together, one staleness column governs both

// Layer 1+2. Own try/catch — never throws out, so a failure here can never
// block the probe below, and one client's Meta failure can't block the rest
// of a tick.
async function checkRegistrationAndHealth(waba, accessToken, db, meta, audit) {
  try {
    const details = await meta.getPhoneNumberDetails(waba.phone_number_id, accessToken);
    // Logged once per refresh, not stripped after "confirmed" — same
    // diagnostic-logging precedent this codebase used for Embedded Signup
    // and the messaging-tier field before trusting an unconfirmed Meta shape.
    console.log(`sendabilityMonitorRunner: raw phone-number details for waba ${waba.waba_id}:`, JSON.stringify(details));

    const isOnBizApp = typeof details?.is_on_biz_app === 'boolean' ? details.is_on_biz_app : null;
    const codeVerificationStatus = typeof details?.code_verification_status === 'string' ? details.code_verification_status : null;
    const platformType = typeof details?.platform_type === 'string' ? details.platform_type : null;
    const phoneStatus = typeof details?.status === 'string' ? details.status : null;
    const healthStatus = details?.health_status && typeof details.health_status === 'object' ? details.health_status : null;
    const now = new Date().toISOString();

    await db.query(
      `update wabas set
         registration_is_on_biz_app = $1,
         registration_code_verification_status = $2,
         registration_platform_type = $3,
         registration_phone_status = $4,
         registration_checked_at = $5,
         health_status = $6,
         health_status_checked_at = $5
       where id = $7`,
      [isOnBizApp, codeVerificationStatus, platformType, phoneStatus, now, healthStatus ? JSON.stringify(healthStatus) : null, waba.id]
    );

    // Every check leaves a trace, not just the outcome — this is the
    // specific gap that let the real outage run 26 hours unnoticed.
    await audit.record({
      actor_type: 'system',
      actor_id: waba.client_id,
      action: 'sendability_registration_checked',
      target: `${waba.client_id}: is_on_biz_app=${isOnBizApp} code_verification_status=${codeVerificationStatus || 'unknown'} platform_type=${platformType || 'unknown'}`,
    });

    return { ok: true, isOnBizApp, codeVerificationStatus, platformType, phoneStatus, healthStatus };
  } catch (err) {
    console.error(`sendabilityMonitorRunner: registration/health check failed for waba ${waba.waba_id}:`, err.message);
    await audit.record({
      actor_type: 'system',
      actor_id: waba.client_id,
      action: 'sendability_registration_check_failed',
      target: `${waba.client_id}: ${err.message}`,
    }).catch((auditErr) => {
      console.error('sendabilityMonitorRunner: failed to record the registration-check failure itself:', auditErr.message);
    });
    return { ok: false, reason: err.message };
  }
}

// Layer 3 — the only check that determines `sendable`. Own try/catch,
// independent of checkRegistrationAndHealth's outcome — see this file's
// header comment for why it must run unconditionally.
async function checkSendabilityProbe(waba, accessToken, db, meta, audit) {
  try {
    // metaClient.probeSendability never throws for a real Meta response
    // (403/404/whatever) — only for a genuine network/timeout failure that
    // never got a response at all. That distinction matters: this catch
    // block only ever runs for the latter, which is NOT evidence sendability
    // changed, so it deliberately does not touch the sendable* columns —
    // leaving whatever verdict was last known stands until a real response
    // says otherwise.
    const result = await meta.probeSendability(waba.phone_number_id, accessToken);
    console.log(`sendabilityMonitorRunner: probe result for waba ${waba.waba_id}:`, JSON.stringify(result));

    const now = new Date().toISOString();
    await db.query(
      `update wabas set
         sendable = $1,
         sendable_reason = $2,
         sendable_error_code = $3,
         sendable_error_data = $4,
         sendable_checked_at = $5
       where id = $6`,
      [result.sendable, result.reason, result.code, result.errorData ? JSON.stringify(result.errorData) : null, now, waba.id]
    );

    // Distinct action names so an unrecognized response is findable on its
    // own, not buried among routine probed-and-classified checks — this is
    // the "raise sendability_unknown" requirement; no alertRunner wiring
    // yet (by direct instruction), but the record itself exists from day one.
    await audit.record({
      actor_type: 'system',
      actor_id: waba.client_id,
      action: result.sendable === null ? 'sendability_unknown' : 'sendability_probed',
      target: `${waba.client_id}: sendable=${result.sendable} code=${result.code ?? 'n/a'} reason=${result.reason || 'n/a'}`,
    });

    return { ok: true, sendable: result.sendable, reason: result.reason, code: result.code };
  } catch (err) {
    console.error(`sendabilityMonitorRunner: probe failed for waba ${waba.waba_id}:`, err.message);
    await audit.record({
      actor_type: 'system',
      actor_id: waba.client_id,
      action: 'sendability_probe_failed',
      target: `${waba.client_id}: ${err.message}`,
    }).catch((auditErr) => {
      console.error('sendabilityMonitorRunner: failed to record the probe failure itself:', auditErr.message);
    });
    return { ok: false, reason: err.message };
  }
}

// Runs Layers 1+2 and Layer 3 for ONE waba, unconditionally, independent of
// each other. Also callable directly by an admin "Check Sendability Now"
// route, bypassing the staleness check, same relationship refreshOne() has
// to messagingTierRefreshRunner.js's admin-triggered refresh.
//
// `deps` ({ db, metaClient, auditLogRepo }) lets a test inject stand-ins for
// all three externals this function touches — the real pool/metaClient/
// auditLogRepo are used when a dep isn't supplied, so production behavior is
// byte-for-byte unchanged. This exists specifically so the load-bearing
// assertions (Layer 1 cannot set sendable; the probe classifies on
// error.code, not HTTP status) can be proven with a stubbed repo and a
// stubbed metaClient — no real database, no real network call, runs
// anywhere, any time. See sendabilityMonitorRunnerUnit.test.js.
async function refreshOne(waba, deps = {}) {
  if (!waba?.access_token_encrypted || !waba.phone_number_id) {
    return { ok: false, reason: 'No connected phone number to check.' };
  }
  const db = deps.db || getPool();
  const meta = deps.metaClient || metaClient;
  const audit = deps.auditLogRepo || getAuditLogRepo();

  let accessToken;
  try {
    accessToken = decrypt(waba.access_token_encrypted);
  } catch (err) {
    return { ok: false, reason: `Could not decrypt stored token: ${err.message}` };
  }

  const registration = await checkRegistrationAndHealth(waba, accessToken, db, meta, audit);
  const probe = await checkSendabilityProbe(waba, accessToken, db, meta, audit);

  return { ok: true, registration, probe };
}

async function refreshNow() {
  const db = getPool();
  const { rows } = await db.query(`select * from wabas where status = 'connected'`);
  const results = [];
  for (const waba of rows) {
    results.push({ wabaId: waba.waba_id, ...(await refreshOne(waba)) });
  }
  return results;
}

async function tick() {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `select * from wabas where status = 'connected'
       and (registration_checked_at is null or registration_checked_at < now() - interval '${STALE_AFTER_MS / 1000} seconds')`
    );
    for (const waba of rows) {
      await refreshOne(waba);
    }
  } catch (err) {
    console.error('sendabilityMonitorRunner tick failed (will retry next tick):', err.message);
  }
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
}
function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, refreshNow, refreshOne };
