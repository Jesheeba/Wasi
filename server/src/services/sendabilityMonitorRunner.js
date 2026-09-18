// Sendability monitoring — all three layers, plus the combined verdict.
// Built after a real 26-hour undetected outage (TNPSC Mentors, 2026-09-18) —
// see migration 074_wabas_sendability.js's header comment for the full
// context and why this is three layers, not one.
//
// Layer 3 (the send probe) was approved 2026-09-18 after validating by hand
// against both a known-good account (Fortune: HTTP 404, code 132001) and the
// known-bad one (TNPSC: HTTP 403, code 200) — see metaClient.probeSendability's
// own header comment. The probe runs for EVERY connected WABA on EVERY
// check, unconditionally — never skipped because health_status looked fine,
// never skipped because Layer 1's registration check flagged something, and
// never skipped just because Layer 1/2's own Meta call failed.
//
// The FIRST real check cycle (2026-09-18) found the probe alone isn't
// enough either: three WABAs (GV Mart, Brainlit, RD Interlock Bricks) came
// back sendable:true from the probe while health_status reported them
// BLOCKED with 141006 (a payment-method error) — the probe tests
// PERMISSION, not overall sendability. See migration
// 076_wabas_sendable_verdict_split.js's header comment for the full
// writeup. That migration renamed the raw probe columns to
// probe_sendable/probe_reason/probe_error_code/probe_error_data/
// probe_checked_at (unchanged meaning, just honestly named) and reclaimed
// wabas.sendable/sendable_reason/sendable_checked_at for the genuinely
// combined verdict computeSendableVerdict below produces: sendable only if
// the probe passes AND no health_status entity is BLOCKED.
//
// A note on why a failed/incomplete health fetch must never overwrite a
// good stored health_status with null (found live, same day): Meta doesn't
// always return health_status on every call, and a registration check can
// fail outright (expired token, timeout) independent of the probe. Losing
// the last known-good health_status to a transient gap would make
// "genuinely never checked" indistinguishable from "checked before, just
// not this time" — checkRegistrationAndHealth's UPDATE uses
// coalesce(new, existing) on every field that can legitimately come back
// absent, and returns the EFFECTIVE (post-coalesce) value to its caller so
// the verdict computation below sees the same truth the database does.
//
// No alertRunner wiring yet — by direct instruction, watch real cycles
// before turning on any alerting against the new verdict.
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
const STALE_AFTER_MS = 4 * 60 * 60 * 1000; // 4h — see the approved plan's cadence reasoning; all layers refresh together, one staleness column governs all

// "New value if Meta actually returned one this call, otherwise whatever
// was already stored" — the in-memory mirror of the SQL coalesce() the
// UPDATE below also applies. Both exist: SQL is the real protection
// (authoritative, safe under a concurrent read), this mirrors it so the
// same call's own return value — and the verdict computation that reads
// it — sees the same effective truth without a second round-trip.
function effective(newValue, oldValue) {
  return newValue !== null && newValue !== undefined ? newValue : (oldValue ?? null);
}

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

    const rawIsOnBizApp = typeof details?.is_on_biz_app === 'boolean' ? details.is_on_biz_app : null;
    const rawCodeVerificationStatus = typeof details?.code_verification_status === 'string' ? details.code_verification_status : null;
    const rawPlatformType = typeof details?.platform_type === 'string' ? details.platform_type : null;
    const rawPhoneStatus = typeof details?.status === 'string' ? details.status : null;
    const rawHealthStatus = details?.health_status && typeof details.health_status === 'object' ? details.health_status : null;
    const now = new Date().toISOString();

    await db.query(
      `update wabas set
         registration_is_on_biz_app = coalesce($1, registration_is_on_biz_app),
         registration_code_verification_status = coalesce($2, registration_code_verification_status),
         registration_platform_type = coalesce($3, registration_platform_type),
         registration_phone_status = coalesce($4, registration_phone_status),
         registration_checked_at = $5,
         health_status = coalesce($6, health_status),
         health_status_checked_at = $5
       where id = $7`,
      [rawIsOnBizApp, rawCodeVerificationStatus, rawPlatformType, rawPhoneStatus, now, rawHealthStatus ? JSON.stringify(rawHealthStatus) : null, waba.id]
    );

    // Every check leaves a trace, not just the outcome — this is the
    // specific gap that let the real outage run 26 hours unnoticed.
    await audit.record({
      actor_type: 'system',
      actor_id: waba.client_id,
      action: 'sendability_registration_checked',
      target: `${waba.client_id}: is_on_biz_app=${rawIsOnBizApp} code_verification_status=${rawCodeVerificationStatus || 'unknown'} platform_type=${rawPlatformType || 'unknown'}`,
    });

    return {
      ok: true,
      isOnBizApp: effective(rawIsOnBizApp, waba.registration_is_on_biz_app),
      codeVerificationStatus: effective(rawCodeVerificationStatus, waba.registration_code_verification_status),
      platformType: effective(rawPlatformType, waba.registration_platform_type),
      phoneStatus: effective(rawPhoneStatus, waba.registration_phone_status),
      // The EFFECTIVE (post-coalesce) health_status — what's actually now
      // stored, whether that's fresh from this call or carried over. null
      // here means genuinely never successfully populated, ever.
      healthStatus: effective(rawHealthStatus, waba.health_status),
    };
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

// Layer 3 — the raw probe result only (permission, not overall
// sendability — see this file's header comment). Writes probe_sendable/
// probe_reason/probe_error_code/probe_error_data/probe_checked_at. Own
// try/catch, independent of checkRegistrationAndHealth's outcome.
async function checkSendabilityProbe(waba, accessToken, db, meta, audit) {
  try {
    // metaClient.probeSendability never throws for a real Meta response
    // (403/404/whatever) — only for a genuine network/timeout failure that
    // never got a response at all. That distinction matters: this catch
    // block only ever runs for the latter, which is NOT evidence anything
    // changed, so it deliberately does not touch the probe_* columns —
    // leaving whatever result was last known stands until a real response
    // says otherwise.
    const result = await meta.probeSendability(waba.phone_number_id, accessToken);
    console.log(`sendabilityMonitorRunner: probe result for waba ${waba.waba_id}:`, JSON.stringify(result));

    const now = new Date().toISOString();
    await db.query(
      `update wabas set
         probe_sendable = $1,
         probe_reason = $2,
         probe_error_code = $3,
         probe_error_data = $4,
         probe_checked_at = $5
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
      target: `${waba.client_id}: probe_sendable=${result.sendable} code=${result.code ?? 'n/a'} reason=${result.reason || 'n/a'}`,
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

// The combined, honest verdict — pure function, no I/O, exported for direct
// unit testing. This is the ONLY thing that should ever be read as "can
// this WABA actually send a real campaign right now":
//   - probeSendable !== true (false OR null) -> mirror the probe exactly;
//     health_status can only ever make a passing probe result WORSE, it can
//     never rescue a failing/unknown one.
//   - probeSendable === true but healthStatus is null (never successfully
//     checked, not merely absent this one time — see checkRegistrationAndHealth's
//     coalesce) -> null. "We couldn't see one of the two signals" is not
//     "it's fine."
//   - probeSendable === true and some health_status entity is BLOCKED
//     (any entity, not just WABA — a BLOCKED PHONE_NUMBER/BUSINESS/APP
//     means the same thing) -> false.
//   - otherwise -> true.
// reason always names which signal produced the verdict ("Probe: ..." vs
// "Health: ...") so nobody has to guess which raw column to open.
function computeSendableVerdict({ probeSendable, probeReason, healthStatus }) {
  if (probeSendable !== true) {
    return { sendable: probeSendable, reason: `Probe: ${probeReason}` };
  }
  if (!healthStatus) {
    return { sendable: null, reason: 'Health: never successfully checked — cannot confirm sendability' };
  }
  const entities = Array.isArray(healthStatus.entities) ? healthStatus.entities : [];
  const blocked = entities.find((e) => e?.can_send_message === 'BLOCKED');
  if (blocked) {
    const code = blocked.errors?.[0]?.error_code;
    const desc = blocked.errors?.[0]?.error_description || 'blocked';
    return { sendable: false, reason: `Health: ${blocked.entity_type || 'an entity'} is BLOCKED${code ? ` (#${code})` : ''} — ${desc}` };
  }
  return { sendable: true, reason: null };
}

// Computes and writes the combined verdict from both sub-checks' results.
// Only recomputed when the probe itself produced a real result (probe.ok)
// — if the probe never reached Meta at all this cycle, there is no new
// information to act on, and the previous verdict is left standing
// untouched, same reasoning checkSendabilityProbe already applies to its
// own probe_* columns.
async function writeSendableVerdict(waba, registration, probe, db, audit) {
  if (!probe.ok) return null;

  const healthStatus = registration.ok ? registration.healthStatus : effective(null, waba.health_status);
  const verdict = computeSendableVerdict({ probeSendable: probe.sendable, probeReason: probe.reason, healthStatus });

  const now = new Date().toISOString();
  await db.query(
    `update wabas set sendable = $1, sendable_reason = $2, sendable_checked_at = $3 where id = $4`,
    [verdict.sendable, verdict.reason, now, waba.id]
  );
  await audit.record({
    actor_type: 'system',
    actor_id: waba.client_id,
    action: 'sendable_verdict_computed',
    target: `${waba.client_id}: sendable=${verdict.sendable} reason=${verdict.reason || 'n/a'}`,
  });
  return verdict;
}

// Runs Layers 1+2, Layer 3, and the combined verdict for ONE waba,
// unconditionally, independent of each other. Also callable directly by an
// admin "Check Sendability Now" route, bypassing the staleness check, same
// relationship refreshOne() has to messagingTierRefreshRunner.js's
// admin-triggered refresh.
//
// `deps` ({ db, metaClient, auditLogRepo }) lets a test inject stand-ins for
// all three externals this function touches — the real pool/metaClient/
// auditLogRepo are used when a dep isn't supplied, so production behavior is
// byte-for-byte unchanged. See sendabilityMonitorRunnerUnit.test.js.
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
  // Layer 3 runs unconditionally — see header comment: registration and
  // health_status can both look fine while sending is still actually
  // blocked, and neither Layer 1/2's own findings nor a failure in that
  // check may ever suppress the probe.
  const probe = await checkSendabilityProbe(waba, accessToken, db, meta, audit);
  const verdict = await writeSendableVerdict(waba, registration, probe, db, audit);

  return { ok: true, registration, probe, verdict };
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

module.exports = { start, stop, tick, refreshNow, refreshOne, computeSendableVerdict };
