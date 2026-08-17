const { pool } = require('../db/pool');

async function list(clientId) {
  const { rows } = await pool.query('select * from team_members where client_id = $1 order by created_at desc', [clientId]);
  return rows;
}

async function create(clientId, { name, email, role }) {
  const { rows } = await pool.query(
    `insert into team_members (client_id, name, email, role) values ($1, $2, $3, coalesce($4, 'Agent')) returning *`,
    [clientId, name, email, role]
  );
  return rows[0];
}

async function remove(clientId, id) {
  const { rowCount } = await pool.query('delete from team_members where client_id = $1 and id = $2', [clientId, id]);
  return rowCount > 0;
}

module.exports = { list, create, remove };
