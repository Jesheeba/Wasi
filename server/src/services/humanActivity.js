// Gate 4 of the AI agent pipeline (docs/ai-agent/SPEC.md section 7): "no human
// is active in this chat". Pure function, no database, so the null handling
// below is pinned by tests rather than left to whoever writes the gate.
//
// Two inputs, both on `chats`:
//   assigned_team_member_id : a person has taken the chat (manual only; no
//                             auto-assignment exists).
//   last_agent_reply_at     : when a person last replied (migration 087).
//
// NULL MEANS UNKNOWN, AND UNKNOWN MEANS "NO RECENT HUMAN REPLY". It is never
// read as a timestamp: `new Date(null)` is the Unix epoch (1970), and an
// arithmetic path that coerced null to 0 would compute a huge age, which
// happens to give the same answer here, but a null-coalescing `?? now`
// somewhere downstream would silence the agent forever. Making the rule
// explicit and tested means a later refactor cannot flip it by accident.
//
// Note the polarity differs from chats.last_inbound_at (gate 3), where null
// means the window is CLOSED (do not send). Here null means the agent MAY
// speak. That is the less safe direction, which is deliberate because the
// alternative (null = human active) would silence the agent on every existing
// chat, none of which are backfilled. It is exactly why, for Coexistence
// clients whose owners reply from their own phone and are not yet visible to
// us (SPEC.md section 10.5, decision 23), schedule_mode 'outside_hours' is the
// real protection and this gate is not.
const HUMAN_ACTIVE_WINDOW_MS = 15 * 60 * 1000;
// A reply timestamp slightly in the future is clock skew between this server
// and the source of the echo's own timestamp: treat it as "just now". One far
// in the future is not trustworthy and must not silence a chat for hours.
const FUTURE_SKEW_TOLERANCE_MS = 60 * 1000;

function toMillis(value) {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Returns { active, reason } where reason is 'assigned' | 'recent_agent_reply'
// | null, matching the `detail.reason` the gate log records for human_active.
function isHumanActive(chat, now = new Date()) {
  if (chat && chat.assigned_team_member_id) {
    return { active: true, reason: 'assigned' };
  }
  const repliedAt = toMillis(chat && chat.last_agent_reply_at);
  if (repliedAt === null) return { active: false, reason: null };

  const age = toMillis(now) - repliedAt;
  if (age >= -FUTURE_SKEW_TOLERANCE_MS && age < HUMAN_ACTIVE_WINDOW_MS) {
    return { active: true, reason: 'recent_agent_reply' };
  }
  return { active: false, reason: null };
}

module.exports = { isHumanActive, HUMAN_ACTIVE_WINDOW_MS, FUTURE_SKEW_TOLERANCE_MS };
