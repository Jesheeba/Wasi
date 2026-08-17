const { pool } = require('../db/pool');

async function list(clientId) {
  const { rows } = await pool.query('select * from tags where client_id = $1 order by name', [clientId]);
  return rows;
}

async function create(clientId, { name, bg, color }) {
  const { rows } = await pool.query(
    `insert into tags (client_id, name, bg, color) values ($1, $2, $3, $4) returning *`,
    [clientId, name, bg || null, color || null]
  );
  return rows[0];
}

module.exports = { list, create };
