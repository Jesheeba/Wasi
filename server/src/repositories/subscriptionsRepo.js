const { pool } = require('../db/pool');

async function findByClientId(clientId) {
  const { rows } = await pool.query(
    'select * from subscriptions where client_id = $1 order by created_at desc limit 1',
    [clientId]
  );
  return rows[0] || null;
}

async function create({ client_id, plan, status, payment_provider_ref }) {
  const { rows } = await pool.query(
    `insert into subscriptions (client_id, plan, status, payment_provider_ref)
     values ($1, $2, coalesce($3, 'pending_payment'), $4)
     returning *`,
    [client_id, plan, status, payment_provider_ref || null]
  );
  return rows[0];
}

async function updateByProviderRef(payment_provider_ref, fields) {
  const columns = Object.keys(fields);
  const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
  const values = columns.map((col) => fields[col]);
  const { rows } = await pool.query(
    `update subscriptions set ${setClause} where payment_provider_ref = $1 returning *`,
    [payment_provider_ref, ...values]
  );
  return rows[0] || null;
}

// Latest subscription per client, joined with client identity — powers the
// admin Billing page (spec §5 "Billing" row).
async function listAllWithClient() {
  const { rows } = await pool.query(`
    select distinct on (s.client_id)
      s.*, c.name as client_name, c.email as client_email, c.tenant_slug
    from subscriptions s
    join clients c on c.id = s.client_id
    order by s.client_id, s.created_at desc
  `);
  return rows;
}

module.exports = { findByClientId, create, updateByProviderRef, listAllWithClient };
