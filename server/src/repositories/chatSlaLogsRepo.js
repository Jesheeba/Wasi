// PLAN.md item 5. Both write functions key off (chat_id, inbound_message_id)
// via the partial unique index migration 048 creates — item 2's
// reopen-on-inbound gives each answer/resolve cycle a distinct inbound
// message, so this is the row identity for "one cycle's SLA record",
// without a separate cycle-number column.
const alertEventsRepo = require('./alertEventsRepo');
const alertNotifier = require('../services/alertNotifier');

function secondsSince(sentAt) {
  return Math.max(0, Math.round((Date.now() - new Date(sentAt).getTime()) / 1000));
}

// Called only from routes/chats.js's POST /:id/messages handler, only when
// the actor is a team member or the owner (never automation/broadcast/Hub
// API) — see that route for the actorType guard. ON CONFLICT DO NOTHING
// against the partial unique index means a SECOND reply to an
// already-answered inbound is silently a no-op here, not an error — only
// the first reply for a given inbound ever gets recorded, matching the
// "first response" the metric is named for. Returns the inserted row, or
// null if this wasn't the first reply (nothing recorded).
async function recordFirstResponseIfAbsent(db, clientId, chatId, teamMemberId, inboundMessage) {
  if (!inboundMessage) return null;
  const { rows } = await db.query(
    `insert into chat_sla_logs (client_id, chat_id, team_member_id, inbound_message_id, first_response_seconds)
     values ($1, $2, $3, $4, $5)
     on conflict (chat_id, inbound_message_id) where inbound_message_id is not null
     do nothing
     returning *`,
    [clientId, chatId, teamMemberId, inboundMessage.id, secondsSince(inboundMessage.sent_at)]
  );
  return rows[0] || null;
}

// Called only from routes/chats.js's POST /:id/resolve handler. Unlike
// first-response, this upserts: a chat can be resolved without ever having
// gotten a tracked first reply (an agent resolves without responding), so
// this may be creating the row fresh, or filling in resolved_seconds on a
// row first-response already created — either way team_member_id is only
// ever SET on insert, never overwritten on conflict, so resolving someone
// else's already-answered chat doesn't reattribute who actually replied.
async function recordResolution(db, clientId, chatId, teamMemberId, inboundMessage) {
  if (!inboundMessage) return null;
  const resolvedSeconds = secondsSince(inboundMessage.sent_at);
  const { rows } = await db.query(
    `insert into chat_sla_logs (client_id, chat_id, team_member_id, inbound_message_id, resolved_seconds)
     values ($1, $2, $3, $4, $5)
     on conflict (chat_id, inbound_message_id) where inbound_message_id is not null
     do update set resolved_seconds = excluded.resolved_seconds
     returning *`,
    [clientId, chatId, teamMemberId, inboundMessage.id, resolvedSeconds]
  );
  return rows[0];
}

// team_member_id: null rows (owner replies) group into their own bucket —
// NULL groups together under a plain GROUP BY, so this never silently
// merges owner activity into a named agent's average. `since` may be null
// (all-time).
async function summaryByTeamMember(db, clientId, since) {
  const { rows } = await db.query(
    `select l.team_member_id, tm.name as team_member_name,
            round(avg(l.first_response_seconds))::int as avg_first_response_seconds,
            round(avg(l.resolved_seconds))::int as avg_resolution_seconds,
            count(l.first_response_seconds)::int as first_response_count,
            count(l.resolved_seconds)::int as resolution_count
     from chat_sla_logs l
     left join team_members tm on tm.id = l.team_member_id
     where l.client_id = $1 and l.created_at > coalesce($2::timestamptz, '-infinity'::timestamptz)
     group by l.team_member_id, tm.name`,
    [clientId, since]
  );
  return rows.map((r) => ({
    teamMemberId: r.team_member_id,
    teamMemberName: r.team_member_id ? r.team_member_name : 'Owner',
    avgFirstResponseSeconds: r.avg_first_response_seconds,
    avgResolutionSeconds: r.avg_resolution_seconds,
    firstResponseCount: r.first_response_count,
    resolutionCount: r.resolution_count,
  }));
}

// Confirmed via direct question: a bare console.error alone only reaches
// Render's log dashboard passively — no push, easily missed, and "SLA
// analytics show suspiciously low/zero counts" carries no signal pointing
// back to this cause. Reuses the existing alertRunner/alertNotifier
// infrastructure (real email, and WhatsApp if configured) rather than
// building a second one. Deduped to ONE open alert for the whole feature,
// not per-chat/per-failure — the root cause of a write failure here is
// almost always systemic (a schema or permission drift), not
// chat-specific, so a second or third failure just touches the same open
// alert instead of sending a fresh email every time. Left for a human to
// investigate and resolve manually — unlike alertRunner's own checks
// (webhook_silence, quality_rating, etc.), there's no periodic re-query of
// "is this still happening" that could safely auto-resolve it, so this
// alert stays open until someone closes it after fixing the real cause.
async function alertOnWriteFailure(err) {
  try {
    const existing = await alertEventsRepo.findOpen('chat_sla_write_failed', 'global');
    if (existing) {
      await alertEventsRepo.touch(existing.id);
      return;
    }
    const created = await alertEventsRepo.open({
      alertType: 'chat_sla_write_failed',
      dedupKey: 'global',
      severity: 'warning',
      message: 'A chat_sla_logs write failed — SLA/first-response-time analytics are silently missing data as a result.',
      details: { error: err.message },
    });
    try {
      await alertNotifier.notify(created);
    } finally {
      await alertEventsRepo.markNotified(created.id);
    }
  } catch (alertErr) {
    // Never let alerting-about-a-failure become its own unhandled failure
    // — this already runs inside a non-fatal catch block in the caller.
    console.error('chatSlaLogsRepo: alertOnWriteFailure itself failed:', alertErr.message);
  }
}

module.exports = { recordFirstResponseIfAbsent, recordResolution, summaryByTeamMember, alertOnWriteFailure };
