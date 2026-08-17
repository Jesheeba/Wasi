const { pool } = require('../db/pool');

async function list() {
  const { rows } = await pool.query('select * from plans order by price_inr asc');
  return rows;
}

async function findById(id) {
  const { rows } = await pool.query('select * from plans where id = $1', [id]);
  return rows[0] || null;
}

module.exports = { list, findById };
