const { pool } = require('../db/pool');

async function findByClientId(clientId) {
  const { rows } = await pool.query('select * from wabas where client_id = $1 order by created_at desc limit 1', [clientId]);
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await pool.query('select * from wabas where id = $1', [id]);
  return rows[0] || null;
}

// Webhook payloads identify the sender by Meta's waba_id, not our client_id —
// this is how every inbound-message/status/template-status handler resolves
// "whose data is this."
async function findByWabaId(wabaId) {
  const { rows } = await pool.query('select * from wabas where waba_id = $1', [wabaId]);
  return rows[0] || null;
}

async function listAllWithClient() {
  const { rows } = await pool.query(
    `select w.*, c.name as client_name, c.tenant_slug
     from wabas w join clients c on c.id = w.client_id
     order by w.created_at desc`
  );
  return rows;
}

async function upsertForClient(clientId, fields) {
  const existing = await findByClientId(clientId);
  const columns = Object.keys(fields);

  if (!existing) {
    const cols = ['client_id', ...columns];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const values = [clientId, ...columns.map((c) => fields[c])];
    const { rows } = await pool.query(
      `insert into wabas (${cols.join(', ')}) values (${placeholders}) returning *`,
      values
    );
    return rows[0];
  }

  const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
  const values = columns.map((col) => fields[col]);
  const { rows } = await pool.query(
    `update wabas set ${setClause} where id = $1 returning *`,
    [existing.id, ...values]
  );
  return rows[0];
}

module.exports = { findByClientId, findById, findByWabaId, listAllWithClient, upsertForClient };
