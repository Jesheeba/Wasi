async function list(db, clientId) {
  const { rows } = await db.query('select * from team_members where client_id = $1 order by created_at desc', [clientId]);
  return rows;
}

async function create(db, clientId, { name, email, role }) {
  const { rows } = await db.query(
    `insert into team_members (client_id, name, email, role) values ($1, $2, $3, coalesce($4, 'Agent')) returning *`,
    [clientId, name, email, role]
  );
  return rows[0];
}

async function remove(db, clientId, id) {
  const { rowCount } = await db.query('delete from team_members where client_id = $1 and id = $2', [clientId, id]);
  return rowCount > 0;
}

async function findById(db, clientId, id) {
  const { rows } = await db.query('select * from team_members where client_id = $1 and id = $2', [clientId, id]);
  return rows[0] || null;
}

// Runs on the privileged pool, not req.db — called from routes/authTeam.js's
// login handler, before any tenant context exists (there's no client_id to
// scope a tenant-restricted connection to until this resolves one). Joins
// through clients.tenant_slug since team_members.email is only unique per
// client_id, not globally (PLAN.md item 1, Open Question 1).
async function findForLogin(pool, tenantSlug, email) {
  const { rows } = await pool.query(
    `select tm.* from team_members tm
     join clients c on c.id = tm.client_id
     where c.tenant_slug = $1 and tm.email = $2`,
    [tenantSlug, email]
  );
  return rows[0] || null;
}

// Also privileged-pool-only, for the same reason as findForLogin — accepting
// an invite happens before any tenant context exists.
async function findByIdAcrossClients(pool, id) {
  const { rows } = await pool.query('select * from team_members where id = $1', [id]);
  return rows[0] || null;
}

async function setPassword(pool, id, passwordHash) {
  const { rows } = await pool.query(
    `update team_members set password_hash = $2, status = 'active' where id = $1 returning *`,
    [id, passwordHash]
  );
  return rows[0] || null;
}

async function touchLastLogin(pool, id) {
  await pool.query('update team_members set last_login_at = now() where id = $1', [id]);
}

module.exports = {
  list,
  create,
  remove,
  findById,
  findForLogin,
  findByIdAcrossClients,
  setPassword,
  touchLastLogin,
};
