async function findById(db, clientId, id) {
  const { rows } = await db.query(
    'select * from flow_nodes where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rows[0] || null;
}

module.exports = { findById };
