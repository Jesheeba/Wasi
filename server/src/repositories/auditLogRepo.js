const { pool } = require('../db/pool');

async function record({ actor_type, actor_id, action, target, actor_ip }) {
  await pool.query(
    `insert into audit_log (actor_type, actor_id, action, target, actor_ip) values ($1, $2, $3, $4, $5)`,
    [actor_type, actor_id || null, action, target || null, actor_ip || null]
  );
}

async function list({ clientId, limit = 100 } = {}) {
  if (clientId) {
    const { rows } = await pool.query(
      `select * from audit_log where target = $1 or actor_id::text = $1 order by created_at desc limit $2`,
      [clientId, limit]
    );
    return rows;
  }
  const { rows } = await pool.query('select * from audit_log order by created_at desc limit $1', [limit]);
  return rows;
}

module.exports = { record, list };
