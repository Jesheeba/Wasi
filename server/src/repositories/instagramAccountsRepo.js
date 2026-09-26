// Deliberately NOT converted to the `db`-first-param convention the other
// tenant repos use (see tagsRepo.js) — mirrors wabasRepo.js exactly:
// access_token_encrypted is never granted to the restricted wasi_app role
// (migration 081_instagram_accounts.js), so every read/write here stays on
// the privileged `pool` connection.
const { pool } = require('../db/pool');

async function findByClientId(clientId) {
  const { rows } = await pool.query(
    'select * from instagram_accounts where client_id = $1 order by created_at desc limit 1',
    [clientId]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await pool.query('select * from instagram_accounts where id = $1', [id]);
  return rows[0] || null;
}

// Webhook payloads identify the sender by Meta's Page id, not our client_id
// — this is how the inbound-message handler resolves "whose data is this."
async function findByPageId(pageId) {
  const { rows } = await pool.query('select * from instagram_accounts where page_id = $1', [pageId]);
  return rows[0] || null;
}

async function upsertForClient(clientId, fields) {
  const existing = await findByClientId(clientId);
  const columns = Object.keys(fields);

  if (!existing) {
    const cols = ['client_id', ...columns];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const values = [clientId, ...columns.map((c) => fields[c])];
    const { rows } = await pool.query(
      `insert into instagram_accounts (${cols.join(', ')}) values (${placeholders}) returning *`,
      values
    );
    return rows[0];
  }

  const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
  const values = columns.map((col) => fields[col]);
  const { rows } = await pool.query(
    `update instagram_accounts set ${setClause} where id = $1 returning *`,
    [existing.id, ...values]
  );
  return rows[0];
}

module.exports = { findByClientId, findById, findByPageId, upsertForClient };
