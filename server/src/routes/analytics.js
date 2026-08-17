const { Router } = require('express');
const { pool } = require('../db/pool');
const { asyncHandler } = require('../utils/asyncHandler');

const router = Router();

// Real message counts for the last 7 days — replaces the hardcoded numbers
// that used to live directly in index.html's Reports > Message view.
router.get('/messages', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `select
       count(*) filter (where direction = 'out')::int as outgoing,
       count(*) filter (where direction = 'in')::int as incoming,
       count(*) filter (where direction = 'out' and status in ('sent', 'delivered', 'read'))::int as sent,
       count(*) filter (where direction = 'out' and status in ('delivered', 'read'))::int as delivered,
       count(*) filter (where direction = 'out' and status = 'read')::int as read,
       count(*) filter (where direction = 'out' and status = 'failed')::int as failed
     from messages
     where client_id = $1 and sent_at > now() - interval '7 days'`,
    [req.clientId]
  );
  res.json(rows[0]);
}));

// Per-tag contact counts + a "conversion" proxy: share of a tag's contacts
// who have at least one outbound message ever (no separate conversion-event
// tracking exists, so this is the closest real signal to "engaged").
router.get('/tags', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `select t.id, t.name, t.bg, t.color,
            count(c.id)::int as contact_count,
            case when count(c.id) = 0 then 0
                 else round(
                   count(c.id) filter (where exists (
                     select 1 from chats ch join messages m on m.chat_id = ch.id
                     where ch.contact_id = c.id and m.direction = 'out'
                   ))::numeric / count(c.id) * 100, 1)
            end as conversion_rate
     from tags t
     left join contacts c on c.tag_id = t.id
     where t.client_id = $1
     group by t.id, t.name, t.bg, t.color
     order by t.name`,
    [req.clientId]
  );
  res.json(rows);
}));

module.exports = router;
