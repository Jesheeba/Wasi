async function list(db, clientId, { flowId } = {}) {
  const { rows } = flowId
    ? await db.query(
        'select * from automation_rules where client_id = $1 and flow_id = $2 order by created_at desc',
        [clientId, flowId]
      )
    : await db.query(
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

async function update(db, clientId, id, { title, trigger }) {
  const { rows } = await db.query(
    `update automation_rules set
       title = coalesce($3, title),
       trigger = coalesce($4, trigger)
     where id = $1 and client_id = $2
     returning *`,
    [id, clientId, title || null, trigger || null]
  );
  return rows[0];
}

module.exports = { list, create, update };
