// PLAN.md item 10 — Contact 360 activity timeline. Merges four independent
// event sources into one chronological feed. Run as 4 parallel queries and
// merged/sorted in JS rather than one SQL UNION ALL — each source has a
// genuinely different shape (messages has no contact_id at all, only
// reachable via chats; broadcast_recipients has no send timestamp of its
// own, only reachable via its sent message), so normalizing all four into
// one SELECT's column list would need as much per-source logic as this
// does, with none of the readability. No schema change — every table here
// already exists.

// messages has no contact_id directly — only reachable via
// chats.contact_id (a chat is the actual conversation; a contact can have
// at most one chat per the existing findOrCreateByContact convention).
//
// Excludes any message a broadcast_recipients row points to via message_id
// — a broadcast send really does create a normal outbound `messages` row
// (visible in the real chat thread), but the plan's 5 event types are
// meant to be mutually exclusive, not layered: that same send is already
// represented, with richer detail (campaign title/template), by
// broadcastSentEvents below. Without this exclusion a broadcast send would
// double-count as both 'message_out' and 'broadcast_sent' for the one real
// underlying send — confirmed as a real bug this test file's own fixture
// caught, not a hypothetical.
async function messageEvents(db, clientId, contactId) {
  const { rows } = await db.query(
    `select m.direction, m.body, m.status, m.sent_at, m.referral
     from messages m
     join chats c on c.id = m.chat_id
     where m.client_id = $1 and c.contact_id = $2
       and not exists (select 1 from broadcast_recipients br where br.message_id = m.id)`,
    [clientId, contactId]
  );
  return rows.map((r) => ({
    type: r.direction === 'in' ? 'message_in' : 'message_out',
    at: r.sent_at,
    // PLAN.md item 14 — referral (Meta's CTWA ad-click object) is only
    // ever present on an inbound message; included when present so this
    // timeline can show "this conversation started from an ad" without a
    // second lookup. Omitted (not a null key) when absent, matching this
    // repo's existing convention of not padding every detail object with
    // every field every OTHER event type might have.
    detail: r.referral ? { body: r.body, status: r.status, referral: r.referral } : { body: r.body, status: r.status },
  }));
}

// Only 'sent' rows — matching the plan's own type name ('broadcast_sent',
// not e.g. 'broadcast_skipped'/'broadcast_failed', neither of which this
// item's endpoint shape documents). broadcast_recipients has no send
// timestamp of its own (created_at is row-creation, not send time) — the
// real send time is messages.sent_at via message_id, set in the same
// update as status='sent' (broadcastRecipientsRepo.markSent), so it's
// always present whenever status is genuinely 'sent'; coalesced to
// created_at only as a defensive fallback, never expected to fire.
async function broadcastSentEvents(db, clientId, contactId) {
  const { rows } = await db.query(
    `select b.title, b.template_name, coalesce(m.sent_at, br.created_at) as at
     from broadcast_recipients br
     join broadcasts b on b.id = br.broadcast_id
     left join messages m on m.id = br.message_id
     where br.client_id = $1 and br.contact_id = $2 and br.status = 'sent'`,
    [clientId, contactId]
  );
  return rows.map((r) => ({
    type: 'broadcast_sent',
    at: r.at,
    detail: { title: r.title, templateName: r.template_name },
  }));
}

// 'entered' is when a contact actually starts a flow (flow_events.event_type
// CHECK, migration 023) — the other event_type values (message_sent,
// button_clicked, timed_out, etc.) are step-by-step execution detail, not
// what this item's 'flow_entered' type describes.
async function flowEnteredEvents(db, clientId, contactId) {
  const { rows } = await db.query(
    `select af.name as flow_name, fe.created_at as at
     from flow_events fe
     join automation_flows af on af.id = fe.flow_id
     where fe.client_id = $1 and fe.contact_id = $2 and fe.event_type = 'entered'`,
    [clientId, contactId]
  );
  return rows.map((r) => ({
    type: 'flow_entered',
    at: r.at,
    detail: { flowName: r.flow_name },
  }));
}

async function consentChangedEvents(db, clientId, contactId) {
  const { rows } = await db.query(
    `select event, source, created_at as at from consent_events where client_id = $1 and contact_id = $2`,
    [clientId, contactId]
  );
  return rows.map((r) => ({
    type: 'consent_changed',
    at: r.at,
    detail: { event: r.event, source: r.source },
  }));
}

// Sequential, not Promise.all — `db` here is req.db, a single
// tenant-scoped checked-out client (tenantContext.js), not the pool.
// node-postgres queues concurrent .query() calls on one Client internally
// (it doesn't error), but recent pg versions deprecate the pattern
// entirely ("will be removed in pg@9") — confirmed for real running this
// file's own test, not just from the changelog. Each of these 4 queries is
// small and independent, so sequential awaits cost nothing meaningful here.
async function getTimeline(db, clientId, contactId) {
  const messages = await messageEvents(db, clientId, contactId);
  const broadcasts = await broadcastSentEvents(db, clientId, contactId);
  const flows = await flowEnteredEvents(db, clientId, contactId);
  const consent = await consentChangedEvents(db, clientId, contactId);
  return [...messages, ...broadcasts, ...flows, ...consent].sort((a, b) => new Date(b.at) - new Date(a.at));
}

module.exports = { getTimeline };
