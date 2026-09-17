// Real-time messaging-tier detection. wabas.messaging_tier (migration 064)
// and this file's own home were both deliberately left as a stub until now
// — see that migration's comment and the TODO(messaging-tier) this replaces
// in alertRunner.js — pending confirmation the real Graph API field name
// wasn't guessed. It's documented in Meta's own public Cloud API reference
// (messaging_limit_tier, on the phone-number resource), so this fetches it
// for real now, but defensively: an absent/unexpected value is stored as
// 'unknown', never silently misreported as a specific tier.
//
// Deliberately its own file, not folded into alertRunner.js despite that
// file's TODO pointing there — alertRunner.js is a pure check-then-alert
// engine (every checkX() function only reads and returns alert candidates;
// none of them fetch-from-Meta-and-persist). A tier refresh is a fetch+write,
// architecturally the same shape as metaTemplateLibraryRefreshRunner.js
// (interval + staleness check + an exported refreshNow() admin routes call
// directly), just per-WABA instead of one-fetch-for-everyone.
const { pool } = require('../db/pool');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');

const TICK_MS = 60 * 60 * 1000; // hourly check
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // tiers don't change minute-to-minute

// Fetches and persists ONE waba's tier. Own try/catch — never throws out, so
// one client's Meta failure (expired token, no real Meta app configured in
// this environment, etc.) can't block every other client's refresh in the
// same tick. Also callable directly by the admin "Refresh Tier" route,
// bypassing the staleness check, same relationship refreshNow() has to
// metaTemplateLibraryRefreshRunner.js's tick().
async function refreshOne(waba) {
  if (!waba?.access_token_encrypted || !waba.phone_number_id) {
    return { ok: false, reason: 'No connected phone number to check.' };
  }
  try {
    const accessToken = decrypt(waba.access_token_encrypted);
    const details = await metaClient.getPhoneNumberDetails(waba.phone_number_id, accessToken);
    // Logged once per refresh, not stripped after this is "confirmed" —
    // matches this codebase's Embedded Signup diagnostic-logging precedent
    // (keep it in until a real live response has actually been inspected).
    console.log(`messagingTierRefreshRunner: raw phone-number details for waba ${waba.waba_id}:`, JSON.stringify(details));

    const tier = typeof details?.messaging_limit_tier === 'string' && details.messaging_limit_tier
      ? details.messaging_limit_tier
      : 'unknown';
    await pool.query(
      `update wabas set messaging_tier = $1, messaging_tier_checked_at = now() where id = $2`,
      [tier, waba.id]
    );
    return { ok: true, tier };
  } catch (err) {
    console.error(`messagingTierRefreshRunner: failed to refresh tier for waba ${waba.waba_id}:`, err.message);
    return { ok: false, reason: err.message };
  }
}

async function refreshNow() {
  const { rows } = await pool.query(`select * from wabas where status = 'connected'`);
  const results = [];
  for (const waba of rows) {
    results.push({ wabaId: waba.waba_id, ...(await refreshOne(waba)) });
  }
  return results;
}

async function tick() {
  try {
    const { rows } = await pool.query(
      `select * from wabas where status = 'connected'
       and (messaging_tier_checked_at is null or messaging_tier_checked_at < now() - interval '${STALE_AFTER_MS / 1000} seconds')`
    );
    for (const waba of rows) {
      await refreshOne(waba);
    }
  } catch (err) {
    console.error('messagingTierRefreshRunner tick failed (will retry next tick):', err.message);
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
