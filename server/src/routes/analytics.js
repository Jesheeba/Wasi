const { Router } = require('express');
const { z } = require('zod');
const wabasRepo = require('../repositories/wabasRepo');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');
const { insightsByAd } = require('./ads');
const chatSlaLogsRepo = require('../repositories/chatSlaLogsRepo');
const conversationPricingRepo = require('../repositories/conversationPricingRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireRole } = require('../middleware/requireRole');
const { costEstimateQuerySchema } = require('../utils/validate');

const router = Router();

router.use(requireRole('Admin', 'Manager'));

// Real message counts for the last 7 days - replaces the hardcoded numbers
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
// contacts.tag_id only - a contact tagged via item 8/8.5's additive
// contact_tags picker never counted toward its tag's contact_count or
// conversion_rate here, silently understating both. Fixed the same way,
// not by replacing tag_id (which still has one real, live write path -
// the Automation Flow Builder's Assign Tag node - this must not regress).
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
// - Agent is deliberately excluded, matching the spec's own matrix.
// ?since is optional (all-time if omitted); team_member_id: null rows
// (owner replies) come back as their own "Owner" bucket, never merged into
// a named agent's average.
router.get('/sla', asyncHandler(async (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : null;
  const byTeamMember = await chatSlaLogsRepo.summaryByTeamMember(req.db, req.clientId, since);
  res.json({ byTeamMember });
}));

// PLAN.md item 14 - CTWA referral attribution. Admin/Manager only,
// inherited from the router.use above. ?since is optional (all-time if
// omitted), same convention as /sla above. Grouped by (source_id,
// headline) rather than source_id alone - a real ad account can run more
// than one headline against the same underlying ad/source, and this
// shouldn't silently merge them into one count.
//
// leadCount = distinct chats an ad started. totals.leads is counted across
// all ads separately (a chat that came in from two ads is one lead overall,
// so summing per-ad leadCount would double count). Ad clicks/spend/CPL are
// deliberately absent: they live in Meta's Marketing API, which this app
// has no access to (build-docs/features/ctwa-ads-page.md).
function parseSince(req, res) {
  if (!req.query.since) return null;
  const since = new Date(req.query.since);
  if (Number.isNaN(since.getTime())) {
    res.status(400).json({ error: 'since must be a valid date' });
    return undefined;
  }
  return since;
}

const CTWA_WHERE = `client_id = $1 and direction = 'in' and referral is not null
       and ($2::timestamptz is null or sent_at > $2)`;

router.get('/ctwa', asyncHandler(async (req, res) => {
  const since = parseSince(req, res);
  if (since === undefined) return;
  const [{ rows }, totals] = await Promise.all([
    req.db.query(
      `select referral->>'source_id' as source_id, referral->>'headline' as headline,
              max(referral->>'source_url') as source_url, max(referral->>'source_type') as source_type,
              count(*)::int as message_count, count(distinct chat_id)::int as lead_count,
              min(sent_at) as first_at, max(sent_at) as last_at
       from messages
       where ${CTWA_WHERE}
       group by referral->>'source_id', referral->>'headline'
       order by lead_count desc, message_count desc`,
      [req.clientId, since]
    ),
    req.db.query(
      `select count(distinct chat_id)::int as leads, count(*)::int as messages
       from messages where ${CTWA_WHERE}`,
      [req.clientId, since]
    ),
  ]);
  // Spend / clicks from the connected Meta ad account (ctwa-ad-metrics.md),
  // matched by ad id = referral.source_id. Cost per lead uses Wasi's own lead
  // count, not Meta's messaging-conversion metric (unconfirmed, and Meta is
  // deprecating conversion metrics in Ads Insights).
  const ymd = (d) => d.toISOString().slice(0, 10);
  const until = ymd(new Date());
  const sinceDay = ymd(since || new Date(Date.now() - 365 * 86400000));
  const ads = await insightsByAd(req.db, req.clientId, { since: sinceDay, until });
  const money = (n) => Math.round(n * 100) / 100;
  let totalSpend = 0;
  const bySource = rows.map((r) => {
    const m = ads.byAd?.get(String(r.source_id)) || null;
    if (m) totalSpend += m.spend;
    return {
      sourceId: r.source_id, headline: r.headline, sourceUrl: r.source_url, sourceType: r.source_type,
      messageCount: r.message_count, leadCount: r.lead_count, firstAt: r.first_at, lastAt: r.last_at,
      ...(m ? { spend: money(m.spend), clicks: m.clicks, impressions: m.impressions, costPerLead: r.lead_count ? money(m.spend / r.lead_count) : null } : {}),
    };
  });
  const t = totals.rows[0];
  res.json({
    totals: { ...t, ads: rows.length, ...(ads.byAd ? { spend: money(totalSpend), costPerLead: t.leads ? money(totalSpend / t.leads) : null } : {}) },
    adsAccount: { connected: ads.connected, hasMetrics: Boolean(ads.byAd), error: ads.error, currency: ads.currency },
    bySource,
  });
}));

// The chats one ad started. sourceId/headline omitted (or empty) match an
// ad Meta sent without that field, so "Unnamed ad" rows can be opened too.
router.get('/ctwa/chats', asyncHandler(async (req, res) => {
  const since = parseSince(req, res);
  if (since === undefined) return;
  const field = (name) => {
    const v = req.query[name];
    return typeof v === 'string' && v !== '' ? v.slice(0, 500) : null;
  };
  const { rows } = await req.db.query(
    `select m.chat_id, ch.name, ch.phone, min(m.sent_at) as first_at, count(*)::int as message_count,
            bool_or(m.referral->>'ctwa_clid' is not null) as has_click_id,
            (select coalesce(array_agg(cv.event_name), '{}') from ctwa_conversions cv where cv.chat_id = m.chat_id) as conversions
     from messages m join chats ch on ch.id = m.chat_id
     where m.client_id = $1 and m.direction = 'in' and m.referral is not null
       and ($2::timestamptz is null or m.sent_at > $2)
       and (m.referral->>'source_id') is not distinct from $3
       and (m.referral->>'headline') is not distinct from $4
     group by m.chat_id, ch.name, ch.phone
     order by first_at desc
     limit 500`,
    [req.clientId, since, field('sourceId'), field('headline')]
  );
  res.json({
    chats: rows.map((r) => ({
      chatId: r.chat_id, name: r.name, phone: r.phone, firstAt: r.first_at, messageCount: r.message_count,
      hasClickId: r.has_click_id, conversions: r.conversions,
    })),
  });
}));

// PLAN.md item 15 - Meta conversation pricing / cost calculator.
// Admin/Manager only, inherited from the router.use above.
//
// Deliberately an explicit what-if calculator, not a real per-category
// cost breakdown: usage_logs.conversations_billed is a single integer per
// (client_id, date) with no category or country dimension at all - nothing
// in this codebase records which category/country a billed conversation
// belonged to, so a true byCategory split cannot be computed from real
// data. category/countryCode are REQUIRED query params for that reason:
// the caller states which single rate to apply against the month's total
// billed count ("if every one of this month's billed conversations were
// priced at this rate, it would cost ~X"), rather than this endpoint
// fabricating a per-category split it has no data to support - same
// discipline as the Meta Official Template Library and Broadcast Engine's
// real-time tier detection (both documented in CLAUDE.md's Known Gaps as
// deliberately not fabricating numbers the app can't actually back).
// byCategory is deliberately NOT part of this response for the same
// reason - see CLAUDE.md's Known Gaps: adding a real category/country
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

// --- Meta analytics (build-docs/features/meta-analytics.md) ---
// Real numbers from Meta: what WhatsApp actually charged (pricing_analytics)
// and per-template performance (template_analytics). Admin/Manager, from the
// router.use above. Fetched live; Meta owns this data.
const metaAnalyticsDays = (q, max) => {
  const n = Number(q);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : 30;
};
async function analyticsWaba(clientId) {
  const waba = await wabasRepo.findByClientId(clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) return null;
  return { waba, token: decrypt(waba.access_token_encrypted) };
}
function analyticsMetaFailure(res, err, fallback) {
  const m = err.metaError;
  const detail = m && (m.error_user_title || m.error_user_msg) ? [m.error_user_title, m.error_user_msg].filter(Boolean).join(' - ') : err.message;
  return res.status(502).json({ error: fallback, detail });
}

router.get('/meta-cost', asyncHandler(async (req, res) => {
  const days = metaAnalyticsDays(req.query.days, 365);
  const conn = await analyticsWaba(req.clientId);
  if (!conn) return res.status(409).json({ error: 'Connect your WhatsApp number first.' });
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  let points;
  try {
    points = await metaClient.getPricingAnalytics(conn.waba.waba_id, conn.token, { start, end });
  } catch (err) {
    return analyticsMetaFailure(res, err, 'Could not load costs from WhatsApp');
  }
  const byDay = new Map();
  const byCategory = new Map();
  let totalVolume = 0;
  let totalCost = 0;
  for (const p of points) {
    const day = new Date(p.start * 1000).toISOString().slice(0, 10);
    const cat = String(p.pricing_category || 'OTHER');
    const volume = Number(p.volume) || 0;
    // Money is summed in integer micro-units so totals round correctly
    // (7.85 + 3.925 is 11.7749999... in floating point).
    const cost = Math.round((Number(p.cost) || 0) * 1e6);
    const free = p.pricing_type && p.pricing_type !== 'REGULAR';
    totalVolume += volume;
    totalCost += cost;
    const d = byDay.get(day) || { day, volume: 0, cost: 0 };
    d.volume += volume; d.cost += cost; byDay.set(day, d);
    const c = byCategory.get(cat) || { category: cat, volume: 0, freeVolume: 0, cost: 0 };
    c.volume += volume; c.cost += cost; if (free) c.freeVolume += volume; byCategory.set(cat, c);
  }
  const round = (micro) => Math.round(micro / 1e4) / 100;
  res.json({
    days,
    totals: { volume: totalVolume, cost: round(totalCost) },
    byCategory: [...byCategory.values()].map((c) => ({ ...c, cost: round(c.cost) })).sort((a, b) => b.cost - a.cost || b.volume - a.volume),
    byDay: [...byDay.values()].map((d) => ({ ...d, cost: round(d.cost) })).sort((a, b) => b.day.localeCompare(a.day)),
  });
}));

router.get('/template-insights', asyncHandler(async (req, res) => {
  const conn = await analyticsWaba(req.clientId);
  if (!conn) return res.status(409).json({ error: 'Connect your WhatsApp number first.' });
  if (!conn.waba.template_insights_enabled_at) return res.json({ enabled: false, templates: [] });
  const days = metaAnalyticsDays(req.query.days, 90);
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  const { rows } = await req.db.query(
    `select name, language, meta_template_id from message_templates
     where client_id = $1 and meta_template_id is not null and orphaned_at is null order by name`,
    [req.clientId]
  );
  const byId = new Map(rows.map((t) => [String(t.meta_template_id), { name: t.name, language: t.language, sent: 0, delivered: 0, read: 0, clicked: 0, cost: 0 }]));
  const ids = [...byId.keys()];
  try {
    for (let i = 0; i < ids.length; i += 10) {
      const points = await metaClient.getTemplateAnalytics(conn.waba.waba_id, conn.token, { start, end, templateIds: ids.slice(i, i + 10) });
      for (const p of points) {
        const t = byId.get(String(p.template_id));
        if (!t) continue;
        t.sent += Number(p.sent) || 0;
        t.delivered += Number(p.delivered) || 0;
        t.read += Number(p.read) || 0;
        t.clicked += (p.clicked || []).reduce((n, c) => n + (Number(c.count) || 0), 0);
        t.cost += (p.cost || []).filter((c) => c.type === 'amount_spent').reduce((n, c) => n + Math.round((Number(c.value) || 0) * 1e6), 0);
      }
    }
  } catch (err) {
    return analyticsMetaFailure(res, err, 'Could not load template analytics from WhatsApp');
  }
  res.json({
    enabled: true,
    enabledAt: conn.waba.template_insights_enabled_at,
    days,
    templates: [...byId.values()].map((t) => ({ ...t, cost: Math.round(t.cost / 1e4) / 100 })).sort((a, b) => b.sent - a.sent),
  });
}));

// Meta: "cannot be disabled" once on. The client must confirm explicitly.
router.post('/template-insights/enable', asyncHandler(async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirm that template analytics cannot be turned off again.' });
  const conn = await analyticsWaba(req.clientId);
  if (!conn) return res.status(409).json({ error: 'Connect your WhatsApp number first.' });
  try {
    await metaClient.enableTemplateInsights(conn.waba.waba_id, conn.token);
  } catch (err) {
    return analyticsMetaFailure(res, err, 'WhatsApp did not turn on template analytics');
  }
  await wabasRepo.markTemplateInsightsEnabled(conn.waba.id);
  res.json({ enabled: true });
}));

// --- Ad lead feedback to Meta (build-docs/features/ctwa-conversions.md) ---
// Reports that an ad-started chat became a lead or a sale, so Meta can
// optimise the ad. One event per chat per type: Meta does not deduplicate.
const conversionSchema = z.object({
  event: z.enum(['LeadSubmitted', 'Purchase']),
  value: z.number().positive().max(10000000).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
});
router.post('/ctwa/chats/:chatId/conversion', asyncHandler(async (req, res) => {
  const chatId = z.string().uuid().parse(req.params.chatId);
  const input = conversionSchema.parse(req.body);
  if (input.event === 'Purchase' && input.value == null) return res.status(400).json({ error: 'Enter the sale amount.' });
  const { rows } = await req.db.query(
    `select referral->>'ctwa_clid' as clid from messages
     where client_id = $1 and chat_id = $2 and direction = 'in' and referral->>'ctwa_clid' is not null
     order by sent_at asc limit 1`,
    [req.clientId, chatId]
  );
  const clid = rows[0]?.clid;
  if (!clid) return res.status(409).json({ error: 'This chat did not start from a Click-to-WhatsApp ad with a click id, so Meta cannot match it.' });
  const done = await req.db.query('select 1 from ctwa_conversions where client_id = $1 and chat_id = $2 and event_name = $3', [req.clientId, chatId, input.event]);
  if (done.rows.length) return res.status(409).json({ error: 'Already reported to Meta for this chat.' });
  const conn = await analyticsWaba(req.clientId);
  if (!conn) return res.status(409).json({ error: 'Connect your WhatsApp number first.' });
  try {
    let datasetId = conn.waba.ctwa_dataset_id;
    if (!datasetId) {
      datasetId = await metaClient.getOrCreateCtwaDataset(conn.waba.waba_id, conn.token);
      await wabasRepo.setCtwaDatasetId(conn.waba.id, datasetId);
    }
    await metaClient.sendCtwaConversion(datasetId, conn.token, {
      wabaId: conn.waba.waba_id, ctwaClid: clid, eventName: input.event,
      value: input.event === 'Purchase' ? input.value : undefined, currency: input.currency,
    });
  } catch (err) {
    return analyticsMetaFailure(res, err, 'Meta did not accept the event');
  }
  await req.db.query(
    'insert into ctwa_conversions (client_id, chat_id, event_name, value, currency, ctwa_clid) values ($1, $2, $3, $4, $5, $6)',
    [req.clientId, chatId, input.event, input.event === 'Purchase' ? input.value : null, input.event === 'Purchase' ? input.currency : null, clid]
  );
  res.status(201).json({ reported: input.event });
}));

module.exports = router;
