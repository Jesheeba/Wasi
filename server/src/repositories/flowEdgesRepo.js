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

module.exports = { listForNode };
