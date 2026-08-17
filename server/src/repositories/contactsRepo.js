const { pool } = require('../db/pool');

async function list(clientId) {
  const { rows } = await pool.query(
    'select * from contacts where client_id = $1 order by created_at desc',
    [clientId]
  );
  return rows;
}

async function findById(clientId, id) {
  const { rows } = await pool.query(
    'select * from contacts where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rows[0] || null;
}

async function create(clientId, { name, phone, tag_id, status }) {
  const { rows } = await pool.query(
    `insert into contacts (client_id, name, phone, tag_id, status)
     values ($1, $2, $3, $4, coalesce($5, 'Active'))
     returning *`,
    [clientId, name, phone, tag_id || null, status]
  );
  return rows[0];
}

async function update(clientId, id, fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return findById(clientId, id);

  const setClause = columns.map((col, i) => `${col} = $${i + 3}`).join(', ');
  const values = columns.map((col) => fields[col]);
  const { rows } = await pool.query(
    `update contacts set ${setClause} where client_id = $1 and id = $2 returning *`,
    [clientId, id, ...values]
  );
  return rows[0] || null;
}

async function remove(clientId, id) {
  const { rowCount } = await pool.query(
    'delete from contacts where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rowCount > 0;
}

async function findByPhone(clientId, phone) {
  const { rows } = await pool.query(
    'select * from contacts where client_id = $1 and phone = $2',
    [clientId, phone]
  );
  return rows[0] || null;
}

// Inbound webhook messages carry a phone + display name + Meta's wa_id, but
// no guarantee we've seen this sender before — create the contact record on
// first contact, keep it as-is (don't overwrite an agent-edited name) after.
async function upsertByPhone(clientId, { phone, name, wa_id }) {
  const existing = await findByPhone(clientId, phone);
  if (existing) {
    if (wa_id && existing.wa_id !== wa_id) {
      const { rows } = await pool.query(
        'update contacts set wa_id = $3 where client_id = $1 and id = $2 returning *',
        [clientId, existing.id, wa_id]
      );
      return rows[0];
    }
    return existing;
  }
  const { rows } = await pool.query(
    `insert into contacts (client_id, name, phone, wa_id, status)
     values ($1, $2, $3, $4, 'Active')
     returning *`,
    [clientId, name || phone, phone, wa_id || null]
  );
  return rows[0];
}

module.exports = { list, findById, create, update, remove, findByPhone, upsertByPhone };
