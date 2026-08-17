const { pool } = require('../db/pool');

async function list() {
  const { rows } = await pool.query('select * from clients order by created_at desc');
  return rows;
}

async function findById(id) {
  const { rows } = await pool.query('select * from clients where id = $1', [id]);
  return rows[0] || null;
}

async function findByEmail(email) {
  const { rows } = await pool.query('select * from clients where email = $1', [email]);
  return rows[0] || null;
}

async function slugExists(tenant_slug) {
  const { rowCount } = await pool.query('select 1 from clients where tenant_slug = $1', [tenant_slug]);
  return rowCount > 0;
}

async function create({ name, email, tenant_slug, status, password_hash }) {
  const { rows } = await pool.query(
    `insert into clients (name, email, tenant_slug, status, password_hash)
     values ($1, $2, $3, coalesce($4, 'pending_setup'), $5)
     returning *`,
    [name, email, tenant_slug, status, password_hash || null]
  );
  return rows[0];
}

async function update(id, fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return findById(id);

  const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
  const values = columns.map((col) => fields[col]);
  const { rows } = await pool.query(
    `update clients set ${setClause} where id = $1 returning *`,
    [id, ...values]
  );
  return rows[0] || null;
}

async function remove(id) {
  const { rowCount } = await pool.query('delete from clients where id = $1', [id]);
  return rowCount > 0;
}

module.exports = { list, findById, findByEmail, slugExists, create, update, remove };
