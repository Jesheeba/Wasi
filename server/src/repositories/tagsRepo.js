// Every function takes `db` (a pg Pool or a checked-out, transaction-scoped
// client) as its first argument — callers on a client-authenticated request
// pass req.db (the restricted, RLS-scoped role set up by
// server/src/middleware/tenantContext.js); admin/system/background callers
// pass the privileged `pool` from ../db/pool directly.
async function list(db, clientId) {
  const { rows } = await db.query('select * from tags where client_id = $1 order by name', [clientId]);
  return rows;
}

async function create(db, clientId, { name, bg, color }) {
  const { rows } = await db.query(
    `insert into tags (client_id, name, bg, color) values ($1, $2, $3, $4) returning *`,
    [clientId, name, bg || null, color || null]
  );
  return rows[0];
}

module.exports = { list, create };
