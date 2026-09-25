// Every function takes `db` first — see tagsRepo.js's module comment for the
// convention. findById/update explicitly select a column list that excludes
// password_hash (no caller anywhere needs it back from these two — auth.js's
// login/register paths use findByEmail instead, which does need it and stays
// unrestricted) so they're safe to run under the restricted role even though
// nothing routes them there today beyond onboarding.js's own-client-row read
// and update.
const SAFE_COLUMNS = `id, name, email, status, tenant_slug, created_at, email_verified,
  contact_person_name, contact_phone, company_details,
  developer_name, developer_phone, developer_email,
  integration_requirements, additional_notes,
  activated_at, payment_status, payment_marked_unpaid_at,
  payment_warning_sent_at, auto_suspended_for_nonpayment, last_reminder_sent_on`;

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

async function create(db, {
  name, email, tenant_slug, status, password_hash,
  contact_person_name, contact_phone, company_details,
  developer_name, developer_phone, developer_email,
  integration_requirements, additional_notes,
}) {
  const { rows } = await db.query(
    `insert into clients (
       name, email, tenant_slug, status, password_hash,
       contact_person_name, contact_phone, company_details,
       developer_name, developer_phone, developer_email,
       integration_requirements, additional_notes
     )
     values ($1, $2, $3, coalesce($4, 'pending_setup'), $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning ${SAFE_COLUMNS}`,
    [
      name, email, tenant_slug, status, password_hash || null,
      contact_person_name || null, contact_phone || null, company_details || null,
      developer_name || null, developer_phone || null, developer_email || null,
      integration_requirements || null, additional_notes || null,
    ]
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

// Payment reminder runner (services/paymentReminderRunner.js) — every
// currently-active client, so the runner can check today's date against
// each one's own activated_at cycle anchor. Kept as a plain list rather
// than a date-filtered query since "today matches this client's
// day-of-month" involves month-end fallback logic that's much clearer done
// once in JS than duplicated across SQL and JS.
async function listActive(db) {
  const { rows } = await db.query(`select ${SAFE_COLUMNS} from clients where status = 'active'`);
  return rows;
}

// Same runner's other half — every client currently flagged unpaid, to
// check the day-3-warning/day-5-suspend timeline against
// payment_marked_unpaid_at. Scoped to status = 'active' here (not left to
// the runner) since only a currently-active client can meaningfully be
// warned or suspended for nonpayment.
async function listUnpaidActive(db) {
  const { rows } = await db.query(
    `select ${SAFE_COLUMNS} from clients where status = 'active' and payment_status = 'unpaid'`
  );
  return rows;
}

// Session invalidation (password reset item 3) — same reasoning as
// adminUsersRepo.bumpTokenVersion: a separate call, not folded into
// update(), so a caller changing password_hash is the one deciding to also
// kill every live session, not an implicit side effect of update() itself.
async function bumpTokenVersion(db, id) {
  await db.query('update clients set token_version = token_version + 1 where id = $1', [id]);
}

module.exports = {
  list, findById, findByEmail, slugExists, create, update, remove, listActive, listUnpaidActive,
  bumpTokenVersion,
};
