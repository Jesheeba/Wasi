const { pool } = require('../db/pool');

async function listByClientId(clientId) {
  const { rows } = await pool.query(
    'select * from support_tickets where client_id = $1 order by created_at desc',
    [clientId]
  );
  return rows;
}

// All tickets across every tenant, joined with client identity — powers the
// admin Support/Tickets page (spec §5 "Support / Tickets" row).
async function listAll(status) {
  const { rows } = await pool.query(
    `select t.*, c.name as client_name, c.email as client_email
     from support_tickets t
     join clients c on c.id = t.client_id
     where $1::text is null or t.status = $1
     order by t.created_at desc`,
    [status || null]
  );
  return rows;
}

async function create(clientId, { subject, message }) {
  const { rows } = await pool.query(
    `insert into support_tickets (client_id, subject, message)
     values ($1, $2, $3)
     returning *`,
    [clientId, subject, message]
  );
  return rows[0];
}

async function updateStatus(id, status) {
  const { rows } = await pool.query(
    `update support_tickets set status = $2, updated_at = now() where id = $1 returning *`,
    [id, status]
  );
  return rows[0] || null;
}

module.exports = { listByClientId, listAll, create, updateStatus };
