// PLAN.md item 9 — AND/OR audience segment builder.
async function list(db, clientId) {
  const { rows } = await db.query('select * from contact_segments where client_id = $1 order by created_at desc', [clientId]);
  return rows;
}

async function findById(db, clientId, id) {
  const { rows } = await db.query('select * from contact_segments where client_id = $1 and id = $2', [clientId, id]);
  return rows[0] || null;
}

async function create(db, clientId, { name, filterJson }) {
  const { rows } = await db.query(
    `insert into contact_segments (client_id, name, filter_json) values ($1, $2, $3) returning *`,
    [clientId, name, JSON.stringify(filterJson)]
  );
  return rows[0];
}

// filterSql/filterParams come from utils/segmentFilter.js's compileFilter,
// called with paramOffset: 1 (client_id is $1 here). Shared by the preview
// route and anywhere else that needs a plain count against a filter
// without inserting anything.
async function countMatching(db, clientId, filterSql, filterParams) {
  const { rows } = await db.query(
    `select count(*)::int as n from contacts where client_id = $1 and (${filterSql})`,
    [clientId, ...filterParams]
  );
  return rows[0].n;
}

module.exports = { list, findById, create, countMatching };
