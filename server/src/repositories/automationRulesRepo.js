async function list(db, clientId) {
  const { rows } = await db.query(
    'select * from automation_rules where client_id = $1 order by created_at desc',
    [clientId]
  );
  return rows;
}

async function create(db, clientId, { title, trigger, action, flow_id }) {
  const { rows } = await db.query(
    `insert into automation_rules (client_id, title, trigger, action, flow_id)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [clientId, title, trigger, action || null, flow_id || null]
  );
  return rows[0];
}

module.exports = { list, create };
