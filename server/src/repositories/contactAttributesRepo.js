const { pool } = require('../db/pool');

async function list(clientId) {
  const { rows } = await pool.query('select * from contact_attributes where client_id = $1 order by created_at desc', [clientId]);
  return rows;
}

async function create(clientId, { name, type }) {
  const { rows } = await pool.query(
    `insert into contact_attributes (client_id, name, type) values ($1, $2, coalesce($3, 'text')) returning *`,
    [clientId, name, type]
  );
  return rows[0];
}

async function remove(clientId, id) {
  const { rowCount } = await pool.query('delete from contact_attributes where client_id = $1 and id = $2', [clientId, id]);
  return rowCount > 0;
}

module.exports = { list, create, remove };
