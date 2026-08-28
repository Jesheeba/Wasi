// Deliberately NOT converted to the `db`-first-param convention the other
// tenant repos use (see tagsRepo.js) — every function here does `select *`
// / `returning *`, and access_token_encrypted is revoked from the restricted
// wasi_app role at the column level (migration 013_tenant_isolation.js).
// Column-level SELECT privilege can't be "partially" satisfied by a
// `select *` query, so running any of these under the restricted role would
// simply error. Rather than special-case column lists per call site, every
// wabas read/write in the app (admin.js, onboarding.js, templates.js,
// messagingService.js) stays on the privileged `pool` — RLS is still
// enabled on wabas as a backstop, but in practice this table's isolation
// relies on the same app-layer `where client_id = $1` it always has.
const { pool } = require('../db/pool');

async function findByClientId(clientId) {
  const { rows } = await pool.query('select * from wabas where client_id = $1 order by created_at desc limit 1', [clientId]);
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await pool.query('select * from wabas where id = $1', [id]);
  return rows[0] || null;
}

// Webhook payloads identify the sender by Meta's waba_id, not our client_id —
// this is how every inbound-message/status/template-status handler resolves
// "whose data is this."
async function findByWabaId(wabaId) {
  const { rows } = await pool.query('select * from wabas where waba_id = $1', [wabaId]);
  return rows[0] || null;
}

// Meta Official Template Library refresh (build plan Phase 2b,
// services/metaTemplateLibraryRefreshRunner.js) — GET /message_template_library
// is Meta's own global catalog, identical regardless of which WABA's token
// asks for it (confirmed in Phase 0 research: no waba-id in the endpoint
// path), so any single currently-connected WABA is sufficient to fetch it
// on behalf of every client. Picked by most-recently-connected, not a
// specific one — there's no reason to prefer one client's WABA over
// another's for a call that reads Meta's own content, not theirs.
async function findAnyConnected() {
  const { rows } = await pool.query(
    `select * from wabas where status = 'connected' order by created_at desc limit 1`
  );
  return rows[0] || null;
}

async function listAllWithClient() {
  const { rows } = await pool.query(
    `select w.*, c.name as client_name, c.tenant_slug
     from wabas w join clients c on c.id = w.client_id
     order by w.created_at desc`
  );
  return rows;
}

async function upsertForClient(clientId, fields) {
  const existing = await findByClientId(clientId);
  const columns = Object.keys(fields);

  if (!existing) {
    const cols = ['client_id', ...columns];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const values = [clientId, ...columns.map((c) => fields[c])];
    const { rows } = await pool.query(
      `insert into wabas (${cols.join(', ')}) values (${placeholders}) returning *`,
      values
    );
    return rows[0];
  }

  const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
  const values = columns.map((col) => fields[col]);
  const { rows } = await pool.query(
    `update wabas set ${setClause} where id = $1 returning *`,
    [existing.id, ...values]
  );
  return rows[0];
}

module.exports = { findByClientId, findById, findByWabaId, findAnyConnected, listAllWithClient, upsertForClient };
