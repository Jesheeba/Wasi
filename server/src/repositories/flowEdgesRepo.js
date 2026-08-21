// 'default' edges always sort last regardless of stored priority, so a
// priority mistake at flow-authoring time can never shadow a real branch —
// this is the runtime half of that guarantee; the editor (Stage 6) is the
// write-time half (rejecting a save that would make a default edge
// unreachable isn't needed since this ordering makes it moot).
async function listForNode(db, clientId, nodeId) {
  const { rows } = await db.query(
    `select * from flow_edges
     where client_id = $1 and from_node_id = $2
     order by (condition_type = 'default') asc, priority asc, created_at asc`,
    [clientId, nodeId]
  );
  return rows;
}

// Whole-flow listing for the editor (server/src/routes/automationFlows.js) —
// same default-last ordering as listForNode, just not scoped to one node.
async function listByFlowId(db, clientId, flowId) {
  const { rows } = await db.query(
    `select * from flow_edges
     where client_id = $1 and flow_id = $2
     order by (condition_type = 'default') asc, priority asc, created_at asc`,
    [clientId, flowId]
  );
  return rows;
}

// When priority isn't explicitly given, this appends the new edge after
// every existing sibling from the same node (max existing priority + 1)
// rather than defaulting to 0 — the editor never used to send priority at
// all, which meant every edge tied at 0 and the real order was silently
// whatever created_at happened to be. Explicit priority is now the actual
// source of truth from the moment an edge is created, not an accident of
// insertion order.
async function create(db, clientId, flowId, { from_node_id, to_node_id, condition_type, condition_value, priority }) {
  const { rows } = await db.query(
    `insert into flow_edges (flow_id, client_id, from_node_id, to_node_id, condition_type, condition_value, priority)
     values ($1, $2, $3, $4, $5, $6,
       coalesce($7, (select coalesce(max(priority), -1) + 1 from flow_edges where from_node_id = $3 and client_id = $2))
     )
     returning *`,
    [flowId, clientId, from_node_id, to_node_id, condition_type, condition_value || null, priority]
  );
  return rows[0];
}

// Reordering sibling branches — the step editor's move-up/move-down
// controls swap two edges' priority via two calls to this. Only priority is
// updatable here; changing condition_type/condition_value/target is a
// delete-and-recreate, same as today (this doesn't change that).
async function update(db, clientId, id, { priority }) {
  const { rows } = await db.query(
    `update flow_edges set priority = $3 where client_id = $1 and id = $2 returning *`,
    [clientId, id, priority]
  );
  return rows[0] || null;
}

async function remove(db, clientId, id) {
  const { rowCount } = await db.query(
    'delete from flow_edges where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rowCount > 0;
}

module.exports = { listForNode, listByFlowId, create, update, remove };
