// Preloaded by `npm test` (node --require). Since 2026-11-24 an account that
// signed up but never paid ('pending_setup') is blocked from everything except
// login and billing (src/services/serviceAccess.js). Tests that register a
// disposable client want a working account, which in production is what
// admin's Service toggle (status 'active') or a confirmed payment gives. This
// does the same, in the test process only: after a successful signup through
// /api/auth/register or /api/auth/google, the new client is set to 'active'.
//
// A test about the unpaid state itself sends the header
// `x-test-keep-unpaid: 1` on its signup call (the server ignores it).
// Browser-side signups (Playwright) are not touched: only Node's fetch is.
// The server-side block is unchanged - nothing here reaches src/.
const realFetch = global.fetch;

global.fetch = async function fetchActivatingTestSignups(input, init = {}) {
  const res = await realFetch(input, init);
  const url = typeof input === 'string' ? input : input?.url || String(input);
  const isSignup = /\/api\/auth\/(register|google)$/.test(url) && (init.method || 'GET').toUpperCase() === 'POST';
  const keepUnpaid = init.headers && (init.headers['x-test-keep-unpaid'] || init.headers['X-Test-Keep-Unpaid']);
  if (!isSignup || keepUnpaid || res.status >= 300) return res;

  const body = await res.clone().json().catch(() => null);
  const clientId = body?.client?.id;
  if (clientId && body.created !== false) {
    const { pool } = require('../../src/db/pool'); // lazy: dbSafety runs only when a test really signs up
    await pool.query(
      "update clients set status = 'active', activated_at = coalesce(activated_at, now()) where id = $1 and status = 'pending_setup'",
      [clientId]
    );
  }
  return res;
};
