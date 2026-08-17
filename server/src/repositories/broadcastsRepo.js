const { pool } = require('../db/pool');

// delivered_count/read_rate are computed live from the underlying messages'
// real Cloud API delivery status (joined via broadcast_recipients.message_id)
// rather than trusted as stored columns — one source of truth, no staleness
// between what the webhook knows and what this list shows.
async function list(clientId) {
  const { rows } = await pool.query(
    `select b.id, b.client_id, b.title, b.tag_id, b.status, b.template_name, b.scheduled_date, b.created_at,
            coalesce(rc.total, 0)::int as recipient_count,
            coalesce(rc.sent, 0)::int as delivered_count,
            case when coalesce(rc.sent, 0) = 0 then 0
                 else round((coalesce(rc.delivered, 0)::numeric / rc.sent) * 100, 2)
            end as delivered_rate,
            case when coalesce(rc.sent, 0) = 0 then 0
                 else round((coalesce(rc.read, 0)::numeric / rc.sent) * 100, 2)
            end as read_rate
     from broadcasts b
     left join lateral (
       select count(*) as total,
              count(*) filter (where br.status = 'sent') as sent,
              count(*) filter (where m.status in ('delivered', 'read')) as delivered,
              count(*) filter (where m.status = 'read') as read
       from broadcast_recipients br
       left join messages m on m.id = br.message_id
       where br.broadcast_id = b.id
     ) rc on true
     where b.client_id = $1
     order by b.created_at desc`,
    [clientId]
  );
  return rows;
}

async function findById(clientId, id) {
  const { rows } = await pool.query('select * from broadcasts where client_id = $1 and id = $2', [clientId, id]);
  return rows[0] || null;
}

async function create(clientId, { title, tag_id, template_name, scheduled_date }) {
  // No scheduled_date (or one that's today/past) -> ready to send now.
  const isFuture = scheduled_date && new Date(scheduled_date) > new Date(new Date().toDateString());
  const status = isFuture ? 'Scheduled' : 'Sending';
  const { rows } = await pool.query(
    `insert into broadcasts (client_id, title, tag_id, template_name, scheduled_date, status)
     values ($1, $2, $3, $4, $5, $6)
     returning *`,
    [clientId, title, tag_id || null, template_name, scheduled_date || null, status]
  );
  return rows[0];
}

async function markStatus(id, status) {
  await pool.query('update broadcasts set status = $2 where id = $1', [id, status]);
}

// Every broadcast whose scheduled date has arrived and still has pending
// recipients — the runner promotes these to 'Sending' each tick.
async function listDueScheduled() {
  const { rows } = await pool.query(
    `select * from broadcasts where status = 'Scheduled' and (scheduled_date is null or scheduled_date <= current_date)`
  );
  return rows;
}

async function listActive() {
  const { rows } = await pool.query(`select * from broadcasts where status = 'Sending'`);
  return rows;
}

module.exports = { list, findById, create, markStatus, listDueScheduled, listActive };
