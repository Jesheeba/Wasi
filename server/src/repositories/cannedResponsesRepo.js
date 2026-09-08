async function list(db, clientId) {
  const { rows } = await db.query(
    'select * from canned_responses where client_id = $1 order by shortcut asc',
    [clientId]
  );
  return rows;
}

async function create(db, clientId, { shortcut, body }) {
  const { rows } = await db.query(
    `insert into canned_responses (client_id, shortcut, body) values ($1, $2, $3) returning *`,
    [clientId, shortcut, body]
  );
  return rows[0];
}

async function remove(db, clientId, id) {
  const { rowCount } = await db.query(
    'delete from canned_responses where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rowCount > 0;
}

module.exports = { list, create, remove };
