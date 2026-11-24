// Gates 1-4 and 6 of the reply pipeline (SPEC section 7), as one pure
// function: no database, no clock except the `now` passed in, so the SPEC
// 16.1 table is a unit test. Gate 5 (no flow matched) is enforced where the
// job is enqueued (aiAgentRunner.enqueueIfEligible, agentMayAnswer allow-list).
// Gates 7-8 depend on the model call and live in agentService.
//
// Returns { pass: true } or { pass: false, gate, log, detail, handover }:
//   gate     - the ai_gate_log reason
//   log      - false only for "agent off" (SPEC: no log line for off/no consent)
//   handover - a reason to set chats.ai_handover_reason, or null
const { isHumanActive } = require('../humanActivity');
const config = require('./config');
const { serviceBlockReason } = require('../serviceAccess');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_PER_HOUR = 4; // SPEC 10.4

// staff_hours: [{ days: [1..6] (0 = Sunday), start: 'HH:MM', end: 'HH:MM' }],
// read in the agent's own timezone. No staff hours = the team is never "in".
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

// The weekday (0 = Sunday) and minute-of-day of `now` in `timezone`.
function localTime(timezone, now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { day: DAYS.indexOf(parts.weekday), minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

function withinStaffHours(staffHours, timezone, now) {
  if (!Array.isArray(staffHours) || staffHours.length === 0) return false;
  const { day, minutes } = localTime(timezone, now);
  return staffHours.some((w) => Array.isArray(w.days) && w.days.includes(day)
    && minutes >= toMin(w.start) && minutes < toMin(w.end));
}

// When the team is next in, as words: "9:00 am tomorrow", "10:30 am on Monday".
// Null when no staff hours are set.
function nextStaffStart(staffHours, timezone, now) {
  if (!Array.isArray(staffHours) || staffHours.length === 0) return null;
  const { day, minutes } = localTime(timezone, now);
  for (let d = 0; d <= 7; d++) {
    const dayIdx = (day + d) % 7;
    const starts = staffHours.filter((w) => Array.isArray(w.days) && w.days.includes(dayIdx))
      .map((w) => toMin(w.start)).filter((m) => d > 0 || m > minutes);
    if (!starts.length) continue;
    const m = Math.min(...starts);
    const h = Math.floor(m / 60);
    const time = `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
    const when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : `on ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayIdx]}`;
    return `${time} ${when}`;
  }
  return null;
}

// Must match migration 103's column default. A client who never edited the
// handover message gets time-aware wording (SPEC section 15); an edited
// message is always sent exactly as written.
const DEFAULT_HANDOVER = "I've passed this on to our team. They'll reply when they're next in.";

function handoverText(agent, now = new Date()) {
  if (agent.handover_message !== DEFAULT_HANDOVER) return agent.handover_message;
  if (withinStaffHours(agent.staff_hours, agent.timezone, now)) {
    return "Let me get someone from our team to help - they'll reply as quickly as they can.";
  }
  const next = nextStaffStart(agent.staff_hours, agent.timezone, now);
  return next
    ? `Our team isn't online right now. I've passed your question on, and they'll reply when they're back at ${next}.`
    : DEFAULT_HANDOVER;
}

const off = (reason) => ({ pass: false, gate: 'agent_off', log: false, detail: { reason }, handover: null });
const stop = (gate, detail = null, handover = null) => ({ pass: false, gate, log: true, detail, handover });

function decide({ agent, client, chat, contactPhone, hasKey, recentRepliesInChat = 0, now = new Date() }) {
  // Gate 1 - agent on, consented, keyed, client in good standing, in pilot, in schedule.
  if (!agent || !agent.is_enabled) return off('disabled');
  if (!agent.ai_consent_at) return off('no_consent');
  if (client && serviceBlockReason(client.status)) return off(serviceBlockReason(client.status));
  if (!hasKey) return stop('no_api_key');
  if (!config.pilotAllows(agent.client_id, contactPhone)) return stop('not_in_pilot');
  if (agent.schedule_mode === 'outside_hours' && withinStaffHours(agent.staff_hours, agent.timezone, now)) {
    return stop('outside_schedule');
  }

  // Gate 2 - two independent pauses, never merged (SPEC section 6).
  if (chat.ai_muted) return stop('muted');
  if (chat.ai_cooldown_until && new Date(chat.ai_cooldown_until) > now) {
    return stop('cooldown', { until: new Date(chat.ai_cooldown_until).toISOString() });
  }

  // Gate 3 - Meta's 24h window. Null last_inbound_at means unknown = closed.
  const inboundAt = chat.last_inbound_at ? new Date(chat.last_inbound_at).getTime() : null;
  if (inboundAt === null || now.getTime() - inboundAt >= WINDOW_MS) {
    return stop('window_closed', null, 'Window closed, AI could not reply');
  }

  // Gate 4 - a person is working the chat.
  const human = isHumanActive(chat, now);
  if (human.active) return stop('human_active', { reason: human.reason });

  // Gate 6 - monthly cap (period already rolled by the caller) and per-chat rate.
  if (agent.replies_used >= agent.monthly_cap) return stop('cap_reached', null, 'Monthly AI reply limit reached');
  if (recentRepliesInChat >= RATE_LIMIT_PER_HOUR) {
    return stop('rate_limited', { perHour: RATE_LIMIT_PER_HOUR }, 'AI reply limit for this chat reached');
  }
  return { pass: true };
}

module.exports = { decide, withinStaffHours, nextStaffStart, handoverText, DEFAULT_HANDOVER, RATE_LIMIT_PER_HOUR };
