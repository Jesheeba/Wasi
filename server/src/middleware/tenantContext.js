const { pool } = require('../db/pool');

// Runs every authenticated client request inside its own transaction, on its
// own checked-out connection, as the restricted `wasi_app` role (see
// migration 013_tenant_isolation.js) with `app.current_client_id` set for
// that transaction only. `SET LOCAL` (both the role switch and the GUC) is
// mandatory, not just tidy, because the pooled connection is reused by
// unrelated requests afterward, and the app connects through Supabase's
// Supavisor pooler in transaction mode — session-level state (plain `SET`)
// isn't guaranteed to survive between transactions on what looks like "one
// connection" to the pool. `SET LOCAL` inside an explicit transaction reverts
// automatically at COMMIT/ROLLBACK regardless, so there's no leak even if
// something below forgets to clean up.
//
// Must commit BEFORE the response is sent, not after (a `res.on('finish')`
// hook fires after bytes are already on the wire — a client could see 201
// for a write that then fails to commit). Route handlers in this codebase
// only ever finish a request via res.json(...) or res.status(n).send(...),
// so those two are wrapped to await commit/rollback first.
// PLAN.md item 10.5 — every client-authenticated request gets a 15s
// statement_timeout by default, so the next unbounded query someone adds
// inherits protection automatically instead of depending on them knowing
// to add it themselves (this is exactly how item 9's two segment routes
// got their own protection — opt-in, not inherited, until now). Same
// SET LOCAL mechanism as ROLE/current_client_id above — reverts
// automatically at COMMIT/ROLLBACK, no leak onto the next pooled request.
// A route needing a different bound (item 9's two routes keep their own
// tighter 5s override) just runs its own SET LOCAL statement_timeout after
// this one — the later value wins within the same transaction, standard
// Postgres behavior, verified in server/test/statementTimeout.test.js.
// Background workers (broadcastRunner, forwardRunner, flowRunner,
// alertRunner) use the privileged `pool` directly, never this function —
// deliberately untouched, a separate decision.
const DEFAULT_STATEMENT_TIMEOUT_MS = 15000;

async function acquireTenantConnection(clientId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE wasi_app');
    await client.query(`select set_config('app.current_client_id', $1, true)`, [clientId]);
    await client.query(`set local statement_timeout = '${DEFAULT_STATEMENT_TIMEOUT_MS}ms'`);
  } catch (err) {
    client.release();
    throw err;
  }
  return client;
}

async function withTenantContext(req, res, next) {
  let client;
  try {
    client = await acquireTenantConnection(req.clientId);
  } catch (err) {
    return next(err);
  }

  req.db = client;

  let settled = false;
  async function finalize(commit) {
    if (settled) return;
    settled = true;
    try {
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
      console.error('tenantContext: commit/rollback failed:', err.message);
    } finally {
      client.release();
    }
  }

  // Lets a route that's about to make a slow external call (e.g. the Meta
  // Cloud API send in routes/chats.js) voluntarily end its transaction and
  // release this connection early, instead of holding one of the pool's few
  // connections idle for the whole call — the same principle forwardRunner.js's
  // module comment already establishes for webhook delivery: a slow external
  // call must never pin a shared resource other requests need. reacquireDb
  // opens a fresh tenant-scoped transaction afterward for any follow-up write;
  // settled resets so the normal res.json/res.send commit below still fires
  // for whichever connection is current when the response actually goes out.
  req.commitAndRelease = () => finalize(true);
  req.reacquireDb = async () => {
    client = await acquireTenantConnection(req.clientId);
    req.db = client;
    settled = false;
    return client;
  };

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = (body) => {
    finalize(res.statusCode < 500)
      .then(() => originalJson(body))
      .catch((err) => { console.error('tenantContext: response after finalize failed:', err.message); });
    return res;
  };
  res.send = (body) => {
    finalize(res.statusCode < 500)
      .then(() => originalSend(body))
      .catch((err) => { console.error('tenantContext: response after finalize failed:', err.message); });
    return res;
  };

  // A client disconnecting before any response method runs (rare) must still
  // release the connection back to the pool instead of leaking it.
  res.on('close', () => finalize(false));

  next();
}

module.exports = { withTenantContext, acquireTenantConnection, DEFAULT_STATEMENT_TIMEOUT_MS };
