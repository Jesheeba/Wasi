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

// Session invalidation (password reset item 3) — called alongside every
// password write so every token issued before it stops verifying on the
// very next request. Not folded into updatePassword() itself: a caller that
// only ever wants the row's password changed, not its live sessions killed,
// should be free to call updatePassword() alone (none exist today, but the
// two aren't the same operation and shouldn't be forced together).
async function bumpTokenVersion(id) {
  await pool.query('update admin_users set token_version = token_version + 1 where id = $1', [id]);
}

module.exports = { list, findByEmail, findById, create, updatePassword, bumpTokenVersion };
