// PLAN.md item 10.5 — default statement_timeout for every tenant-scoped
// request. Verifies:
// 1. A connection acquired the normal way (acquireTenantConnection) really
//    has the 15s default applied — SHOW statement_timeout reports it, not
//    just "the code intends to set it."
// 2. A route-level override still works after this change — a shorter
//    SET LOCAL statement_timeout layered on top of the 15s default still
//    cancels a deliberately slow query with real Postgres error 57014,
//    same mechanism item 9's contactSegments.test.js test 10 already
//    proved in general, re-verified here specifically through
//    acquireTenantConnection's own connection setup (SET LOCAL ROLE +
//    current_client_id already applied), not a bare pool connection.
// No dedicated-test-client needed — this doesn't touch any client-owned
// data, just the connection-setup mechanism itself.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db/pool');
const { acquireTenantConnection, DEFAULT_STATEMENT_TIMEOUT_MS } = require('../src/middleware/tenantContext');

after(async () => {
  await pool.end();
});

test('1. acquireTenantConnection applies the 15s default statement_timeout', async () => {
  const client = await acquireTenantConnection('00000000-0000-0000-0000-000000000000');
  try {
    const { rows } = await client.query('show statement_timeout');
    // Postgres normalizes a whole-seconds ms value to its own "Ns" display
    // format when reporting a GUC back via SHOW — a formatting difference,
    // not a real mismatch (confirmed against DEFAULT_STATEMENT_TIMEOUT_MS
    // itself so this stays correct if that constant ever changes).
    assert.equal(rows[0].statement_timeout, `${DEFAULT_STATEMENT_TIMEOUT_MS / 1000}s`);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('2. a route-level override still cancels a slow query after the default is in place', async () => {
  const client = await acquireTenantConnection('00000000-0000-0000-0000-000000000000');
  try {
    // Confirms the default really is active first (not a 0/disabled value
    // that would make this test pass for the wrong reason).
    const before = await client.query('show statement_timeout');
    assert.equal(before.rows[0].statement_timeout, `${DEFAULT_STATEMENT_TIMEOUT_MS / 1000}s`);

    await client.query(`set local statement_timeout = '100ms'`);
    await assert.rejects(
      client.query('select pg_sleep(1)'),
      (err) => {
        assert.equal(err.code, '57014', 'must be a real query_canceled error — the override, not just the default, must still work');
        return true;
      }
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
