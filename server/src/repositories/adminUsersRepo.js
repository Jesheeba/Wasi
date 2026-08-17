const { pool } = require('../db/pool');

async function list() {
  const { rows } = await pool.query('select id, name, email, role, created_at from admin_users order by created_at desc');
  return rows;
}

async function findByEmail(email) {
  const { rows } = await pool.query('select * from admin_users where email = $1', [email]);
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await pool.query('select id, name, email, role, created_at from admin_users where id = $1', [id]);
  return rows[0] || null;
}

async function create({ name, email, role, password_hash }) {
  const { rows } = await pool.query(
    `insert into admin_users (name, email, role, password_hash)
     values ($1, $2, $3, $4)
     returning id, name, email, role, created_at`,
    [name, email, role, password_hash]
  );
  return rows[0];
}

async function updatePassword(id, password_hash) {
  await pool.query('update admin_users set password_hash = $2 where id = $1', [id, password_hash]);
}

module.exports = { list, findByEmail, findById, create, updatePassword };
