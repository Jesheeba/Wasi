// The WhatsApp number's daily messaging limit (Meta's "messaging tier"),
// how much of it this app estimates is used, and the number's quality
// rating - one shape shared by the Campaigns page, Settings, the New
// Campaign preflight warning (routes/broadcasts.js) and the Hub API's
// GET /api/v1/account, so every place a client can look says the same thing.
//
// Meta's limit counts unique people reached OUTSIDE an open 24-hour
// customer service window, over a rolling 24h. usedToday approximates that
// from this app's own send history: distinct chats with an outbound
// message in the last 24h that was not a failed send and was not sent
// while the customer's window was open (no inbound message from them in
// the 24h before it). Still an estimate, never Meta's live count: it can't
// see sends made outside this app.
const wabasRepo = require('../repositories/wabasRepo');
const metaClient = require('../utils/metaClient');

async function usedConversationsLast24h(db, clientId) {
  const { rows } = await db.query(
    `select count(distinct m.chat_id)::int as used
       from messages m
      where m.client_id = $1
        and m.direction = 'out'
        and m.sent_at >= now() - interval '24 hours'
        and m.status is distinct from 'failed'
        and not exists (
          select 1 from messages i
           where i.client_id = $1
             and i.chat_id = m.chat_id
             and i.direction = 'in'
             and i.sent_at <= m.sent_at
             and i.sent_at > m.sent_at - interval '24 hours'
        )`,
    [clientId]
  );
  return rows[0].used;
}

async function getMessagingLimitStatus(db, clientId) {
  const waba = await wabasRepo.findByClientId(clientId);
  const tier = waba?.messaging_tier || null;
  const cap = tier ? metaClient.messagingTierCap(tier) : null;
  const base = {
    connected: Boolean(waba && waba.status === 'connected'),
    tier,
    qualityRating: waba?.quality_rating || null,
    tierCheckedAt: waba?.messaging_tier_checked_at || null,
  };
  if (!tier || cap === null) {
    // Unknown tier (never checked, or a value this app doesn't recognise):
    // never claim a limit we don't know.
    return { ...base, unlimited: false, capNumber: null, usedToday: null, remaining: null };
  }
  const unlimited = cap === Infinity;
  // JSON can't carry Infinity, so capNumber/remaining stay null when
  // unlimited; `unlimited` disambiguates that from "unknown".
  const usedToday = await usedConversationsLast24h(db, clientId);
  const remaining = unlimited ? null : Math.max(0, cap - usedToday);
  return { ...base, unlimited, capNumber: unlimited ? null : cap, usedToday, remaining };
}

module.exports = { getMessagingLimitStatus, usedConversationsLast24h };
