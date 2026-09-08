async function list(db, clientId) {
  const { rows } = await db.query('select * from contact_attributes where client_id = $1 order by created_at desc', [clientId]);
  return rows;
}

async function create(db, clientId, { name, type }) {
  const { rows } = await db.query(
    `insert into contact_attributes (client_id, name, type) values ($1, $2, coalesce($3, 'text')) returning *`,
    [clientId, name, type]
  );
  return rows[0];
}

async function remove(db, clientId, id) {
  const { rowCount } = await db.query('delete from contact_attributes where client_id = $1 and id = $2', [clientId, id]);
  return rowCount > 0;
}

module.exports = { list, create, remove };
