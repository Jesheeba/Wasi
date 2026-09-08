const { Router } = require('express');
const chatSlaLogsRepo = require('../repositories/chatSlaLogsRepo');
const conversationPricingRepo = require('../repositories/conversationPricingRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireRole } = require('../middleware/requireRole');
const { costEstimateQuerySchema } = require('../utils/validate');

const router = Router();

router.use(requireRole('Admin', 'Manager'));

// Real message counts for the last 7 days — replaces the hardcoded numbers
// that used to live directly in index.html's Reports > Message view.
router.get('/messages', asyncHandler(async (req, res) => {
  const { rows } = await req.db.query(
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
//
// Real bug, fixed (same OR EXISTS shape as broadcastRecipientsRepo.js's
// createFromAudience, per explicit review): this used to join on
// contacts.tag_id only — a contact tagged via item 8/8.5's additive
// contact_tags picker never counted toward its tag's contact_count or
// conversion_rate here, silently understating both. Fixed the same way,
// not by replacing tag_id (which still has one real, live write path —
// the Automation Flow Builder's Assign Tag node — this must not regress).
// The OR in the join condition can't double-count a contact matching both
// mechanisms (e.g. via migration 050's backfill): it's one row per
// (tag, contact) pair where EITHER condition holds, not one per condition.
router.get('/tags', asyncHandler(async (req, res) => {
  const { rows } = await req.db.query(
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
     left join contacts c on (
       c.tag_id = t.id
       or exists (select 1 from contact_tags ct where ct.contact_id = c.id and ct.tag_id = t.id)
     )
     where t.client_id = $1
     group by t.id, t.name, t.bg, t.color
     order by t.name`,
    [req.clientId]
  );
  res.json(rows);
}));

// PLAN.md item 5. Admin/Manager only, inherited from the router.use above
// — Agent is deliberately excluded, matching the spec's own matrix.
// ?since is optional (all-time if omitted); team_member_id: null rows
// (owner replies) come back as their own "Owner" bucket, never merged into
// a named agent's average.
router.get('/sla', asyncHandler(async (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : null;
  const byTeamMember = await chatSlaLogsRepo.summaryByTeamMember(req.db, req.clientId, since);
  res.json({ byTeamMember });
}));

// PLAN.md item 14 — CTWA referral attribution. Admin/Manager only,
// inherited from the router.use above. ?since is optional (all-time if
// omitted), same convention as /sla above. Grouped by (source_id,
// headline) rather than source_id alone — a real ad account can run more
// than one headline against the same underlying ad/source, and this
// shouldn't silently merge them into one count.
router.get('/ctwa', asyncHandler(async (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : null;
  const { rows } = await req.db.query(
    `select referral->>'source_id' as source_id, referral->>'headline' as headline, count(*)::int as message_count
     from messages
     where client_id = $1 and direction = 'in' and referral is not null
       and ($2::timestamptz is null or sent_at > $2)
     group by referral->>'source_id', referral->>'headline'
     order by message_count desc`,
    [req.clientId, since]
  );
  res.json({
    bySource: rows.map((r) => ({ sourceId: r.source_id, headline: r.headline, messageCount: r.message_count })),
  });
}));

// PLAN.md item 15 — Meta conversation pricing / cost calculator.
// Admin/Manager only, inherited from the router.use above.
//
// Deliberately an explicit what-if calculator, not a real per-category
// cost breakdown: usage_logs.conversations_billed is a single integer per
// (client_id, date) with no category or country dimension at all — nothing
// in this codebase records which category/country a billed conversation
// belonged to, so a true byCategory split cannot be computed from real
// data. category/countryCode are REQUIRED query params for that reason:
// the caller states which single rate to apply against the month's total
// billed count ("if every one of this month's billed conversations were
// priced at this rate, it would cost ~X"), rather than this endpoint
// fabricating a per-category split it has no data to support — same
// discipline as the Meta Official Template Library and Broadcast Engine's
// real-time tier detection (both documented in CLAUDE.md's Known Gaps as
// deliberately not fabricating numbers the app can't actually back).
// byCategory is deliberately NOT part of this response for the same
// reason — see CLAUDE.md's Known Gaps: adding a real category/country
// dimension to usage_logs (and writing it at every real send site) is its
// own future item, not something to fake here.
router.get('/cost-estimate', asyncHandler(async (req, res) => {
  const { month, category, countryCode } = costEstimateQuerySchema.parse(req.query);

  const { rows } = await req.db.query(
    `select coalesce(sum(conversations_billed), 0)::int as total
     from usage_logs
     where client_id = $1 and to_char(date, 'YYYY-MM') = $2`,
    [req.clientId, month]
  );
  const conversationsBilled = rows[0].total;

  const rateInr = await conversationPricingRepo.findRate(req.db, category, countryCode);
  const rateConfigured = rateInr !== null;

  res.json({
    month,
    category,
    countryCode,
    conversationsBilled,
    rateConfigured,
    rateInr: rateConfigured ? Number(rateInr) : null,
    estimatedInr: rateConfigured ? Number((conversationsBilled * rateInr).toFixed(2)) : null,
  });
}));

module.exports = router;
