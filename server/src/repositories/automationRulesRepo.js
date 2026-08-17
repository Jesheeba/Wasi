const { pool } = require('../db/pool');

async function list(clientId) {
  const { rows } = await pool.query(
    'select * from automation_rules where client_id = $1 order by created_at desc',
    [clientId]
  );
  return rows;
}

async function create(clientId, { title, trigger, action }) {
  const { rows } = await pool.query(
    `insert into automation_rules (client_id, title, trigger, action)
     values ($1, $2, $3, $4)
     returning *`,
    [clientId, title, trigger, action]
  );
  return rows[0];
}

module.exports = { list, create };
