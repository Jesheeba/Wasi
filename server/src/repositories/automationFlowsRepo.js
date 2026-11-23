async function findById(db, clientId, id) {
  const { rows } = await db.query(
    'select * from automation_flows where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rows[0] || null;
}

async function list(db, clientId) {
  const { rows } = await db.query(
    'select * from automation_flows where client_id = $1 order by created_at desc',
    [clientId]
  );
  return rows;
}

async function create(db, clientId, { name }) {
  const { rows } = await db.query(
    `insert into automation_flows (client_id, name) values ($1, $2) returning *`,
    [clientId, name]
  );
  return rows[0];
}

async function update(db, clientId, id, fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return findById(db, clientId, id);

  const setClause = columns.map((col, i) => `${col} = $${i + 3}`).join(', ');
  const values = columns.map((col) => fields[col]);
  const { rows } = await db.query(
    `update automation_flows set ${setClause}, updated_at = now() where client_id = $1 and id = $2 returning *`,
    [clientId, id, ...values]
  );
  return rows[0] || null;
}

// Rules that start this flow are deleted with it. automation_rules.flow_id is
// ON DELETE SET NULL, but a rule with neither action nor flow_id violates
// automation_rules_action_xor_flow, so without this the flow delete failed
// outright for any flow a rule pointed at. req.db is one transaction, so the
// two deletes commit or roll back together.
async function remove(db, clientId, id) {
  await db.query('delete from automation_rules where client_id = $1 and flow_id = $2', [clientId, id]);
  const { rowCount } = await db.query(
    'delete from automation_flows where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rowCount > 0;
}

module.exports = { findById, list, create, update, remove };
