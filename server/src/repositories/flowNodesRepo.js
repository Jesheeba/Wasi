async function findById(db, clientId, id) {
  const { rows } = await db.query(
    'select * from flow_nodes where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rows[0] || null;
}

async function listByFlowId(db, clientId, flowId) {
  const { rows } = await db.query(
    'select * from flow_nodes where client_id = $1 and flow_id = $2 order by created_at asc',
    [clientId, flowId]
  );
  return rows;
}

async function create(db, clientId, flowId, { type, config, position }) {
  const { rows } = await db.query(
    `insert into flow_nodes (flow_id, client_id, type, config, position)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [flowId, clientId, type, JSON.stringify(config || {}), position ? JSON.stringify(position) : null]
  );
  return rows[0];
}

async function update(db, clientId, id, { config, position }) {
  const { rows } = await db.query(
    `update flow_nodes set config = coalesce($3, config), position = coalesce($4, position)
     where client_id = $1 and id = $2
     returning *`,
    [clientId, id, config ? JSON.stringify(config) : null, position ? JSON.stringify(position) : null]
  );
  return rows[0] || null;
}

async function remove(db, clientId, id) {
  const { rowCount } = await db.query(
    'delete from flow_nodes where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rowCount > 0;
}

module.exports = { findById, listByFlowId, create, update, remove };
