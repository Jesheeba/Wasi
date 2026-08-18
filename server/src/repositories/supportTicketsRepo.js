async function listByClientId(db, clientId) {
  const { rows } = await db.query(
    'select * from support_tickets where client_id = $1 order by created_at desc',
    [clientId]
  );
  return rows;
}

// All tickets across every tenant, joined with client identity — powers the
// admin Support/Tickets page (spec §5 "Support / Tickets" row). Admin-only,
// always the privileged connection.
async function listAll(db, status) {
  const { rows } = await db.query(
    `select t.*, c.name as client_name, c.email as client_email
     from support_tickets t
     join clients c on c.id = t.client_id
     where $1::text is null or t.status = $1
     order by t.created_at desc`,
    [status || null]
  );
  return rows;
}

async function create(db, clientId, { subject, message }) {
  const { rows } = await db.query(
    `insert into support_tickets (client_id, subject, message)
     values ($1, $2, $3)
     returning *`,
    [clientId, subject, message]
  );
  return rows[0];
}

// Admin-only status flip — always the privileged connection.
async function updateStatus(db, id, status) {
  const { rows } = await db.query(
    `update support_tickets set status = $2, updated_at = now() where id = $1 returning *`,
    [id, status]
  );
  return rows[0] || null;
}

module.exports = { listByClientId, listAll, create, updateStatus };
