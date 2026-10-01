const { pool } = require('../db/pool');

// Same ladder chatsRepo.decideStatusTransition enforces for messages: a late
// 'delivered' must never knock a 'read' row back down, and 'failed' never
// overrides a message already delivered/read.
const RANK = { sent: 1, delivered: 2, read: 3 };

async function record(row) {
  const { rows } = await pool.query(
    `insert into payment_notifications
       (client_id, client_name, recipient_phone, kind, trigger, template_name, status,
        meta_message_id, error_message, triggered_by, sent_at, failed_at)
     values ($1,$2,$3,$4,$5,$6,$7::text,$8,$9,$10,
             case when $7::text = 'sent' then now() end,
             case when $7::text = 'failed' then now() end)
     returning *`,
    [row.client_id || null, row.client_name, row.recipient_phone || null, row.kind, row.trigger,
      row.template_name, row.status, row.meta_message_id || null, row.error_message || null, row.triggered_by || null]
  );
  return rows[0];
}

// Called from metaWebhook.js's handleStatuses for every status Meta sends.
// A no-op (null) for any message id that isn't one of ours — the common case.
async function updateStatusByMetaId(metaMessageId, status, errorMessage) {
  if (status !== 'failed' && !RANK[status]) return null;
  const { rows: existing } = await pool.query(
    'select status from payment_notifications where meta_message_id = $1',
    [metaMessageId]
  );
  if (existing.length === 0) return null;
  const current = existing[0].status;

  if (status === 'failed') {
    if (RANK[current] >= RANK.delivered) return null;
  }

  const { rows } = await pool.query(
    `update payment_notifications set
       status = case
         when $2::text = 'failed' then 'failed'
         when (case status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end) < $4::int then $2::text
         else status end,
       error_message = case when $2::text = 'failed' then coalesce($3, error_message) else error_message end,
       delivered_at = case when $2::text = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
       read_at = case when $2::text = 'read' then coalesce(read_at, now()) else read_at end,
       failed_at = case when $2::text = 'failed' then coalesce(failed_at, now()) else failed_at end
     where meta_message_id = $1 returning *`,
    [metaMessageId, status, errorMessage || null, RANK[status] || 0]
  );
  return rows[0] || null;
}

async function list({ status, kind, clientId, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (kind) { params.push(kind); where.push(`kind = $${params.length}`); }
  if (clientId) { params.push(clientId); where.push(`client_id = $${params.length}`); }
  params.push(Math.min(Number(limit) || 200, 1000));
  const { rows } = await pool.query(
    `select * from payment_notifications ${where.length ? 'where ' + where.join(' and ') : ''}
     order by created_at desc limit $${params.length}`,
    params
  );
  return rows;
}

async function summary() {
  const { rows } = await pool.query(`
    select count(*)::int as total,
           count(*) filter (where status = 'sent')::int as sent_only,
           count(*) filter (where status = 'delivered')::int as delivered_only,
           count(*) filter (where status = 'read')::int as read,
           count(*) filter (where status = 'failed')::int as failed,
           count(distinct client_id) filter (where kind = 'payment_reminder')::int as clients_reminded
    from payment_notifications`);
  return rows[0];
}

module.exports = { record, updateStatusByMetaId, list, summary };
