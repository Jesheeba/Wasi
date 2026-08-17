const { pool } = require('../db/pool');

async function create(confirmationCode, fbUserId) {
  const { rows } = await pool.query(
    `insert into data_deletion_requests (confirmation_code, fb_user_id) values ($1, $2) returning *`,
    [confirmationCode, fbUserId || null]
  );
  return rows[0];
}

async function findByCode(confirmationCode) {
  const { rows } = await pool.query('select * from data_deletion_requests where confirmation_code = $1', [confirmationCode]);
  return rows[0] || null;
}

async function markCompleted(confirmationCode) {
  const { rows } = await pool.query(
    `update data_deletion_requests set status = 'completed', completed_at = now() where confirmation_code = $1 returning *`,
    [confirmationCode]
  );
  return rows[0] || null;
}

async function listPending() {
  const { rows } = await pool.query(`select * from data_deletion_requests where status = 'pending' order by requested_at asc`);
  return rows;
}

module.exports = { create, findByCode, markCompleted, listPending };
