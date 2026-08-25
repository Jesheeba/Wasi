async function findByClientId(db, clientId) {
  const { rows } = await db.query(
    'select * from subscriptions where client_id = $1 order by created_at desc limit 1',
    [clientId]
  );
  return rows[0] || null;
}

async function create(db, { client_id, plan, status, payment_provider_ref, billing_mode }) {
  const { rows } = await db.query(
    `insert into subscriptions (client_id, plan, status, payment_provider_ref, billing_mode)
     values ($1, $2, coalesce($3, 'pending_payment'), $4, coalesce($5, 'one_off'))
     returning *`,
    [client_id, plan, status, payment_provider_ref || null, billing_mode || null]
  );
  return rows[0];
}

// Looked up by provider ref rather than client_id — used both by the
// Razorpay webhook (privileged connection, no client context at all) and by
// billing.js's client-initiated cancel route (req.db); RLS's policy still
// applies on top of whatever WHERE clause is here, so either caller is safe.
async function updateByProviderRef(db, payment_provider_ref, fields) {
  const columns = Object.keys(fields);
  const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
  const values = columns.map((col) => fields[col]);
  const { rows } = await db.query(
    `update subscriptions set ${setClause} where payment_provider_ref = $1 returning *`,
    [payment_provider_ref, ...values]
  );
  return rows[0] || null;
}

// Latest subscription per client, joined with client identity — powers the
// admin Billing page (spec §5 "Billing" row). Admin-only, privileged.
async function listAllWithClient(db) {
  const { rows } = await db.query(`
    select distinct on (s.client_id)
      s.*, c.name as client_name, c.email as client_email, c.tenant_slug
    from subscriptions s
    join clients c on c.id = s.client_id
    order by s.client_id, s.created_at desc
  `);
  return rows;
}

module.exports = { findByClientId, create, updateByProviderRef, listAllWithClient };
