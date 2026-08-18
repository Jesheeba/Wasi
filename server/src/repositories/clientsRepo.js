// Every function takes `db` first — see tagsRepo.js's module comment for the
// convention. findById/update explicitly select a column list that excludes
// password_hash (no caller anywhere needs it back from these two — auth.js's
// login/register paths use findByEmail instead, which does need it and stays
// unrestricted) so they're safe to run under the restricted role even though
// nothing routes them there today beyond onboarding.js's own-client-row read
// and update.
const SAFE_COLUMNS = 'id, name, email, status, tenant_slug, created_at, email_verified';

async function list(db) {
  const { rows } = await db.query(`select ${SAFE_COLUMNS} from clients order by created_at desc`);
  return rows;
}

async function findById(db, id) {
  const { rows } = await db.query(`select ${SAFE_COLUMNS} from clients where id = $1`, [id]);
  return rows[0] || null;
}

// Pre-auth (login/register/forgot-password) — needs password_hash, so this
// intentionally is NOT column-restricted. Only ever called with the
// privileged pool, before req.clientId (and therefore req.db) exist.
async function findByEmail(db, email) {
  const { rows } = await db.query('select * from clients where email = $1', [email]);
  return rows[0] || null;
}

async function slugExists(db, tenant_slug) {
  const { rowCount } = await db.query('select 1 from clients where tenant_slug = $1', [tenant_slug]);
  return rowCount > 0;
}

async function create(db, { name, email, tenant_slug, status, password_hash }) {
  const { rows } = await db.query(
    `insert into clients (name, email, tenant_slug, status, password_hash)
     values ($1, $2, $3, coalesce($4, 'pending_setup'), $5)
     returning ${SAFE_COLUMNS}`,
    [name, email, tenant_slug, status, password_hash || null]
  );
  return rows[0];
}

async function update(db, id, fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return findById(db, id);

  const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
  const values = columns.map((col) => fields[col]);
  const { rows } = await db.query(
    `update clients set ${setClause} where id = $1 returning ${SAFE_COLUMNS}`,
    [id, ...values]
  );
  return rows[0] || null;
}

async function remove(db, id) {
  const { rowCount } = await db.query('delete from clients where id = $1', [id]);
  return rowCount > 0;
}

module.exports = { list, findById, findByEmail, slugExists, create, update, remove };
