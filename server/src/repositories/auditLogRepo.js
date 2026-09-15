const { pool } = require('../db/pool');

async function record({ actor_type, actor_id, action, target, actor_ip }) {
  await pool.query(
    `insert into audit_log (actor_type, actor_id, action, target, actor_ip) values ($1, $2, $3, $4, $5)`,
    [actor_type, actor_id || null, action, target || null, actor_ip || null]
  );
}

async function list({ clientId, limit = 100 } = {}) {
  if (clientId) {
    // Real, pre-existing bug found and fixed here: `target` is free text
    // (auditLogRepo has no fixed shape for it), and two conventions exist
    // side by side across the codebase — a bare id (razorpayWebhook.js's
    // event target, admin.js's retry_provisioning/template_${status}/etc.)
    // and an "id: description" prefix (clients.js's client_password_reset/
    // api_key_created, admin.js's own api_key_created). The old `target =
    // $1` exact match only ever matched the first convention — every
    // "id: description" row (client_password_reset, api_key_created, and
    // now this feature's client_status_changed/client_marked_paid/unpaid)
    // has never actually surfaced on the admin Client Detail page's Audit
    // Trail card, despite being written correctly. Matching both shapes.
    const { rows } = await pool.query(
      `select * from audit_log where target = $1 or target like $1 || ': %' or actor_id::text = $1 order by created_at desc limit $2`,
      [clientId, limit]
    );
    return rows;
  }
  const { rows } = await pool.query('select * from audit_log order by created_at desc limit $1', [limit]);
  return rows;
}

module.exports = { record, list };
