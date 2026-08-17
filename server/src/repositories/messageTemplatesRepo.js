const { pool } = require('../db/pool');

async function listByClientId(clientId) {
  const { rows } = await pool.query(
    'select * from message_templates where client_id = $1 order by created_at desc',
    [clientId]
  );
  return rows;
}

async function create({ client_id, name, category, status, body }) {
  const { rows } = await pool.query(
    `insert into message_templates (client_id, name, category, status, body)
     values ($1, $2, $3, coalesce($4, 'pending'), $5)
     returning *`,
    [client_id, name, category, status, body]
  );
  return rows[0];
}

// All templates across every tenant, joined with client identity — powers
// the admin Templates Review queue (spec §5 "Templates Review" row).
async function listAll(status) {
  const { rows } = await pool.query(
    `select t.*, c.name as client_name, c.tenant_slug
     from message_templates t
     join clients c on c.id = t.client_id
     where $1::text is null or t.status = $1
     order by t.created_at desc`,
    [status || null]
  );
  return rows;
}

async function updateStatus(id, status) {
  const { rows } = await pool.query(
    `update message_templates set status = $2, updated_at = now() where id = $1 returning *`,
    [id, status]
  );
  return rows[0] || null;
}

module.exports = { listByClientId, create, listAll, updateStatus };
