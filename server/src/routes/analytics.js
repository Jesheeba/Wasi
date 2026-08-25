const { Router } = require('express');
const { asyncHandler } = require('../utils/asyncHandler');

const router = Router();

// GAP_FIX_PLAN.md Phase E3 — same clamp convention admin.js's
// GET /api/admin/volume?days= already uses (1-365, default matches each
// endpoint's own prior hardcoded window so an unparameterized call from
// before this change behaves identically).
function parseDays(req, fallback) {
  return Math.min(Math.max(parseInt(req.query.days, 10) || fallback, 1), 365);
}

function csvField(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  return [header.join(','), ...rows.map((row) => row.map(csvField).join(','))].join('\r\n');
}

function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

// Real message counts for the window — replaces the hardcoded numbers that
// used to live directly in index.html's Reports > Message view. Default
// (7 days, no ?days=) is byte-for-byte the original hardcoded window —
// only widens behavior for a caller that explicitly asks for a different one.
router.get('/messages', asyncHandler(async (req, res) => {
  const days = parseDays(req, 7);
  const { rows } = await req.db.query(
    `select
       count(*) filter (where direction = 'out')::int as outgoing,
       count(*) filter (where direction = 'in')::int as incoming,
       count(*) filter (where direction = 'out' and status in ('sent', 'delivered', 'read'))::int as sent,
       count(*) filter (where direction = 'out' and status in ('delivered', 'read'))::int as delivered,
       count(*) filter (where direction = 'out' and status = 'read')::int as read,
       count(*) filter (where direction = 'out' and status = 'failed')::int as failed
     from messages
     where client_id = $1 and sent_at > now() - ($2 || ' days')::interval`,
    [req.clientId, days]
  );
  res.json(rows[0]);
}));

// Per-day breakdown of the same counts /messages aggregates — a trend, not
// a point-in-time total. New in Phase E3; /messages above is unchanged for
// existing callers that only want the aggregate.
async function queryMessagesTrend(db, clientId, days) {
  const { rows } = await db.query(
    `select
       date_trunc('day', sent_at)::date as date,
       count(*) filter (where direction = 'out')::int as outgoing,
       count(*) filter (where direction = 'in')::int as incoming,
       count(*) filter (where direction = 'out' and status in ('sent', 'delivered', 'read'))::int as sent,
       count(*) filter (where direction = 'out' and status in ('delivered', 'read'))::int as delivered,
       count(*) filter (where direction = 'out' and status = 'read')::int as read,
       count(*) filter (where direction = 'out' and status = 'failed')::int as failed
     from messages
     where client_id = $1 and sent_at > now() - ($2 || ' days')::interval
     group by 1
     order by 1`,
    [clientId, days]
  );
  return rows;
}

router.get('/messages/trend', asyncHandler(async (req, res) => {
  res.json(await queryMessagesTrend(req.db, req.clientId, parseDays(req, 30)));
}));

router.get('/messages/export', asyncHandler(async (req, res) => {
  const days = parseDays(req, 30);
  const rows = await queryMessagesTrend(req.db, req.clientId, days);
  const csv = toCsv(
    ['Date', 'Outgoing', 'Incoming', 'Sent', 'Delivered', 'Read', 'Failed'],
    rows.map((r) => [r.date.toISOString().slice(0, 10), r.outgoing, r.incoming, r.sent, r.delivered, r.read, r.failed])
  );
  sendCsv(res, `wasi-messages-${days}d.csv`, csv);
}));

// Per-tag contact counts + a "conversion" proxy: share of a tag's contacts
// who have at least one outbound message ever (no separate conversion-event
// tracking exists, so this is the closest real signal to "engaged").
async function queryTags(db, clientId) {
  const { rows } = await db.query(
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
    [clientId]
  );
  return rows;
}

router.get('/tags', asyncHandler(async (req, res) => {
  res.json(await queryTags(req.db, req.clientId));
}));

router.get('/tags/export', asyncHandler(async (req, res) => {
  const rows = await queryTags(req.db, req.clientId);
  const csv = toCsv(
    ['Tag', 'Contacts', 'Conversion Rate %'],
    rows.map((r) => [r.name, r.contact_count, r.conversion_rate])
  );
  sendCsv(res, 'wasi-tags.csv', csv);
}));

// New contacts per day within the window, plus a running cumulative total
// (the cumulative starting point is the count of contacts that already
// existed before the window began, not zero — a growth chart starting
// every window at 0 would be misleading for an account with existing contacts).
router.get('/contacts/growth', asyncHandler(async (req, res) => {
  const days = parseDays(req, 30);
  const [{ rows: before }, { rows: daily }] = await Promise.all([
    req.db.query(
      `select count(*)::int as count from contacts where client_id = $1 and created_at <= now() - ($2 || ' days')::interval`,
      [req.clientId, days]
    ),
    req.db.query(
      `select date_trunc('day', created_at)::date as date, count(*)::int as new_contacts
       from contacts
       where client_id = $1 and created_at > now() - ($2 || ' days')::interval
       group by 1
       order by 1`,
      [req.clientId, days]
    ),
  ]);

  let cumulative = before[0].count;
  const trend = daily.map((row) => {
    cumulative += row.new_contacts;
    return { date: row.date, newContacts: row.new_contacts, cumulativeContacts: cumulative };
  });
  res.json({ startingCount: before[0].count, trend });
}));

// Broadcast/campaign performance over time — a trend (grouped by send
// day), not the point-in-time list GET /api/broadcasts already returns.
// Multiple campaigns on the same day roll up into one row (sum delivered,
// average read rate) rather than one row per campaign.
router.get('/campaigns/trend', asyncHandler(async (req, res) => {
  const days = parseDays(req, 30);
  const { rows } = await req.db.query(
    `select
       date_trunc('day', created_at)::date as date,
       count(*)::int as campaigns,
       coalesce(sum(delivered_count), 0)::int as delivered,
       coalesce(round(avg(read_rate), 1), 0) as avg_read_rate
     from broadcasts
     where client_id = $1 and created_at > now() - ($2 || ' days')::interval
     group by 1
     order by 1`,
    [req.clientId, days]
  );
  res.json(rows);
}));

module.exports = router;
