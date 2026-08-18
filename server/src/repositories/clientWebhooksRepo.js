async function findByClientId(db, clientId) {
  const { rows } = await db.query('select * from client_webhooks where client_id = $1', [clientId]);
  return rows[0] || null;
}

async function upsert(db, clientId, callbackUrl, secret, events) {
  const { rows } = await db.query(
    `insert into client_webhooks (client_id, callback_url, secret, events)
     values ($1, $2, $3, $4)
     on conflict (client_id) do update set callback_url = $2, secret = $3, events = $4, updated_at = now()
     returning *`,
    [clientId, callbackUrl, secret, events]
  );
  return rows[0];
}

module.exports = { findByClientId, upsert };
