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
async function withTenantContext(req, res, next) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE wasi_app');
    await client.query(`select set_config('app.current_client_id', $1, true)`, [req.clientId]);
  } catch (err) {
    if (client) client.release();
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

module.exports = { withTenantContext };
