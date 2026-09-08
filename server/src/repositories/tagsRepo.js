// Every function takes `db` (a pg Pool or a checked-out, transaction-scoped
// client) as its first argument — callers on a client-authenticated request
// pass req.db (the restricted, RLS-scoped role set up by
// server/src/middleware/tenantContext.js); admin/system/background callers
// pass the privileged `pool` from ../db/pool directly.
async function list(db, clientId) {
  const { rows } = await db.query('select * from tags where client_id = $1 order by name', [clientId]);
  return rows;
}

async function findById(db, clientId, id) {
  const { rows } = await db.query('select * from tags where client_id = $1 and id = $2', [clientId, id]);
  return rows[0] || null;
}

async function create(db, clientId, { name, bg, color }) {
  const { rows } = await db.query(
    `insert into tags (client_id, name, bg, color) values ($1, $2, $3, $4) returning *`,
    [clientId, name, bg || null, color || null]
  );
  return rows[0];
}

// PLAN.md item 8's CSV-import tag wiring — a CSV "tags" cell only ever
// carries names, so this is a race-safe find-or-create keyed on the real
// tags_client_name_unique constraint (migration 003), same
// INSERT...ON CONFLICT DO UPDATE-as-no-op pattern already established for
// this exact TOCTOU class of bug (contactsRepo.importFromRows,
// contactListsRepo.addMembersFromRows) rather than a racier SELECT-then-INSERT.
async function findOrCreateByName(db, clientId, name) {
  const { rows } = await db.query(
    `insert into tags (client_id, name) values ($1, $2)
     on conflict (client_id, name) do update set name = tags.name
     returning *`,
    [clientId, name]
  );
  return rows[0];
}

module.exports = { list, findById, create, findOrCreateByName };
