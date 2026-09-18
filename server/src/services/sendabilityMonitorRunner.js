// Sendability monitoring, Layers 1 and 2 (registration + health_status).
// Built after a real 26-hour undetected outage (TNPSC Mentors, 2026-09-18) —
// see migration 074_wabas_sendability.js's header comment for the full
// context and why this is three layers, not one.
//
// Layer 3 (the actual send probe, POST .../messages with a nonexistent
// template — the only layer proven, by hand, to catch the billing-shaped
// failure that caused the outage) is a SEPARATE, later approval and is not
// implemented here. This file fetches and persists registration + health
// fields only, and deliberately never writes wabas.sendable/
// sendable_checked_at/sendable_reason/sendable_error_code — those columns
// exist (migration 074) but stay null until Layer 3 ships. This is not an
// oversight: is_on_biz_app === false AND code_verification_status !==
// 'VERIFIED' was floated as a "definitely can't send" rule, but it is an
// unconfirmed hypothesis (TNPSC registered successfully this morning and
// code_verification_status stayed EXPIRED regardless of whether the number
// could actually send) — an unvalidated heuristic must not be able to
// override what the empirical probe will find. Only the probe decides
// `sendable`.
//
// Same fetch+persist shape as messagingTierRefreshRunner.js (own file, own
// interval, staleness-gated tick, refreshOne/refreshNow split for the admin
// "check now" button) — see that file's header comment for why this kind of
// job isn't folded into alertRunner.js's pure check-then-alert shape.
//
// Unlike messagingTierRefreshRunner.js, every check here writes a real
// audit_log entry, not just the admin-triggered manual one — silent failure
// is what let the TNPSC outage run 26 hours undetected, so this runner does
// not repeat that specific gap even though its sibling file does.
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
const STALE_AFTER_MS = 4 * 60 * 60 * 1000; // 4h — see the approved plan's cadence reasoning

// Fetches and persists Layers 1+2 for ONE waba. Own try/catch — never throws
// out, so one client's Meta failure can't block the rest of a tick. Also
// callable directly by an admin "Check Registration & Health Now" route,
// bypassing the staleness check, same relationship refreshOne() has to
// messagingTierRefreshRunner.js's admin-triggered refresh.
//
// `deps` ({ db, metaClient, auditLogRepo }) lets a test inject stand-ins for
// all three externals this function touches — the real pool/metaClient/
// auditLogRepo are used when a dep isn't supplied, so production behavior is
// byte-for-byte unchanged. This exists specifically so the load-bearing
// assertion ("Layer 1 cannot set sendable") can be proven with a stubbed
// repo and a stubbed metaClient — no real database, no real network call,
// runs anywhere, any time. See sendabilityMonitorRunnerUnit.test.js.
async function refreshOne(waba, deps = {}) {
  if (!waba?.access_token_encrypted || !waba.phone_number_id) {
    return { ok: false, reason: 'No connected phone number to check.' };
  }
  const db = deps.db || getPool();
  const meta = deps.metaClient || metaClient;
  const audit = deps.auditLogRepo || getAuditLogRepo();

  try {
    const accessToken = decrypt(waba.access_token_encrypted);
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
    // specific gap that let today's outage run 26 hours unnoticed.
    await audit.record({
      actor_type: 'system',
      actor_id: waba.client_id,
      action: 'sendability_registration_checked',
      target: `${waba.client_id}: is_on_biz_app=${isOnBizApp} code_verification_status=${codeVerificationStatus || 'unknown'} platform_type=${platformType || 'unknown'}`,
    });

    return { ok: true, isOnBizApp, codeVerificationStatus, platformType, phoneStatus, healthStatus };
  } catch (err) {
    console.error(`sendabilityMonitorRunner: failed to check waba ${waba.waba_id}:`, err.message);
    // Still a trace, even on failure — a check that silently never happened
    // is indistinguishable from "nothing is wrong," which is exactly how
    // today's outage stayed invisible.
    await audit.record({
      actor_type: 'system',
      actor_id: waba.client_id,
      action: 'sendability_registration_check_failed',
      target: `${waba.client_id}: ${err.message}`,
    }).catch((auditErr) => {
      console.error('sendabilityMonitorRunner: failed to record the failure itself:', auditErr.message);
    });
    return { ok: false, reason: err.message };
  }
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
