// Same shape as every other runner in this file's sibling services
// (broadcastRunner/forwardRunner/flowRunner/alertRunner): idempotent
// start()/stop() over setInterval, one try/catch around the whole tick so a
// single failure can't crash the process, plus a try/catch PER CLIENT
// inside each half of the tick (broadcastRunner's own hardening precedent —
// one client's bad data or a transient send failure must never block every
// other client's reminder/warning/suspend check that tick).
//
// Two independent responsibilities, both gated on real signals this app
// actually has (never a fabricated one):
//  1. Monthly payment reminder — every client with status='active', on the
//     calendar day matching their own activated_at's day-of-month (their
//     real "date they started using the application"), at most once per
//     day. Independent of payment_status — this is a scheduled nudge, not
//     a consequence of being marked unpaid.
//  2. Nonpayment warning/auto-suspend — every client flagged payment_status
//     ='unpaid'. Day 3 (WARNING_AFTER_DAYS) since payment_marked_unpaid_at:
//     one warning message, once. Day 5 (SUSPEND_AFTER_DAYS): auto-suspend
//     (status -> 'suspended'), stamping auto_suspended_for_nonpayment so a
//     later "mark paid" (routes/clients.js) knows THIS mechanism did the
//     suspending, not an unrelated manual action, before it silently
//     reactivates anything.
const clientsRepo = require('../repositories/clientsRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const paymentNotificationService = require('../services/paymentNotificationService');
const paymentReminderSchedulesRepo = require('../repositories/paymentReminderSchedulesRepo');
const { pool } = require('../db/pool');

const TICK_MS = 60 * 60 * 1000; // hourly — cheap, and a once-a-day-per-client event tolerates an hour's slack fine
const WARNING_AFTER_DAYS = 3;
const SUSPEND_AFTER_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

// UTC-based — used to CREATE a new date-only marker from a real point in
// time (e.g. "what day is it right now"). Self-consistent with
// isReminderDueToday's own UTC day-of-month math below.
function todayDateString(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// Recovers a 'YYYY-MM-DD' string from a `date`-typed column's value as
// node-postgres actually hands it back — NOT the same job as
// todayDateString above, and not interchangeable with it. Real bug found
// writing this feature's own tests: pg's default DATE (oid 1082) parser
// constructs the JS Date via `new Date(year, month, day)` — LOCAL-time
// semantics — while todayDateString reads a Date back out via
// toISOString(), which is UTC. On any server whose local timezone isn't
// UTC, that mismatch silently shifts the calendar day by one, so a raw
// `!==` comparison between "what we stored" and "what pg gave back" is
// simply wrong. The fix is to reconstruct the string the same way pg
// constructed the Date (local getters) rather than the UTC way
// todayDateString does — that exactly reverses pg's own construction and
// recovers the original stored string regardless of server timezone.
// Defensive against a plain string too, in case a caller ever passes one
// directly instead of a DB-read value.
function dateOnlyString(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

// The reminder's cycle anchor is activated_at's day-of-month, with a
// month-end fallback (e.g. activated on the 31st still fires on the 30th of
// a 30-day month, rather than never firing that month) — and never fires in
// the same calendar month a client was activated, since they don't owe
// anything yet on day zero.
function isReminderDueToday(client, now = new Date()) {
  if (!client.activated_at) return false;
  const activated = new Date(client.activated_at);
  if (activated.getUTCFullYear() === now.getUTCFullYear() && activated.getUTCMonth() === now.getUTCMonth()) {
    return false;
  }
  const lastDayOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const effectiveDay = Math.min(activated.getUTCDate(), lastDayOfThisMonth);
  if (now.getUTCDate() !== effectiveDay) return false;
  return dateOnlyString(client.last_reminder_sent_on) !== todayDateString(now);
}

function daysSince(timestamp, now = new Date()) {
  return (now.getTime() - new Date(timestamp).getTime()) / DAY_MS;
}

// Per-client, side-effecting — the unit this codebase's own tests target
// directly (see broadcastRunner.processBroadcast's precedent), never the
// bulk list-and-loop functions below: this shared database has real,
// live clients, and a test calling the bulk version would process every
// real active/unpaid client in production, not just its own disposable
// test row. `db` defaults to the privileged pool (what the real runner
// always uses) but is overridable so a test can pass its own connection.
async function sendReminderIfDue(client, now = new Date(), db = pool) {
  if (!isReminderDueToday(client, now)) return false;
  try {
    const result = await paymentNotificationService.sendAndLog(client, {
      kind: 'payment_reminder', trigger: 'scheduled', name: 'wasi_payment_reminder',
      bodyParams: { client_name: client.name },
    });
    if (result.ok) {
      await auditLogRepo.record({ actor_type: 'system', action: 'payment_reminder_sent', target: `${client.id}: ${client.name}` });
    } else {
      console.error(`paymentReminderRunner: reminder failed for ${client.id} (${client.name}):`, result.error);
    }
  } catch (err) {
    console.error(`paymentReminderRunner: reminder failed for ${client.id} (${client.name}):`, err.message);
  } finally {
    // Marked sent even if the actual WhatsApp send failed (e.g. the
    // template isn't approved yet) — same reasoning alertRunner's
    // markNotified uses: this is a once-a-day scheduled event, not a
    // retry queue, so a transient failure shouldn't turn into the runner
    // hammering the same send every hour for the rest of the day.
    await clientsRepo.update(db, client.id, { last_reminder_sent_on: todayDateString(now) });
  }
  return true;
}

// Per-client nonpayment check — same "test this, never the bulk loop"
// reasoning as sendReminderIfDue above. Returns which action fired ('warned'
// | 'suspended' | null) so a test can assert on it directly.
async function enforceNonpaymentForClient(client, now = new Date(), db = pool) {
  if (!client.payment_marked_unpaid_at) return null;
  const daysUnpaid = daysSince(client.payment_marked_unpaid_at, now);

  if (daysUnpaid >= SUSPEND_AFTER_DAYS) {
    await clientsRepo.update(db, client.id, { status: 'suspended', auto_suspended_for_nonpayment: true });
    await auditLogRepo.record({ actor_type: 'system', action: 'auto_suspended_nonpayment', target: `${client.id}: ${client.name}` });
    try {
      const result = await paymentNotificationService.sendAndLog(client, {
        kind: 'service_suspended', trigger: 'nonpayment_timeline', name: 'wasi_service_suspended',
        bodyParams: { client_name: client.name },
      });
      if (!result.ok) console.error(`paymentReminderRunner: suspension notice failed for ${client.id} (${client.name}):`, result.error);
    } catch (sendErr) {
      console.error(`paymentReminderRunner: suspension notice failed for ${client.id} (${client.name}):`, sendErr.message);
    }
    return 'suspended';
  }

  if (daysUnpaid >= WARNING_AFTER_DAYS && !client.payment_warning_sent_at) {
    try {
      const result = await paymentNotificationService.sendAndLog(client, {
        kind: 'suspension_warning', trigger: 'nonpayment_timeline', name: 'wasi_suspension_warning',
        bodyParams: { client_name: client.name, days_remaining: String(Math.max(0, Math.ceil(SUSPEND_AFTER_DAYS - daysUnpaid))) },
      });
      if (!result.ok) console.error(`paymentReminderRunner: warning failed for ${client.id} (${client.name}):`, result.error);
    } catch (sendErr) {
      console.error(`paymentReminderRunner: warning failed for ${client.id} (${client.name}):`, sendErr.message);
    }
    await clientsRepo.update(db, client.id, { payment_warning_sent_at: now.toISOString() });
    await auditLogRepo.record({ actor_type: 'system', action: 'payment_suspension_warning_sent', target: `${client.id}: ${client.name}` });
    return 'warned';
  }

  return null;
}

// Bulk wrappers — real production traffic only (the live runner's tick).
async function sendReminders(now = new Date()) {
  const clients = await clientsRepo.listActive(pool);
  for (const client of clients) {
    try {
      await sendReminderIfDue(client, now);
    } catch (err) {
      console.error(`paymentReminderRunner: reminder check failed for ${client.id} (${client.name}):`, err.message);
    }
  }
}

async function enforceNonpayment(now = new Date()) {
  const clients = await clientsRepo.listUnpaidActive(pool);
  for (const client of clients) {
    try {
      await enforceNonpaymentForClient(client, now);
    } catch (err) {
      console.error(`paymentReminderRunner: nonpayment check failed for ${client.id} (${client.name}):`, err.message);
    }
  }
}

// --- Admin-defined monthly schedules (payment_reminder_schedules) ---
// "Day N of every month at hour H, India time, remind every active client."
// India time because that's who sets and reads these; the per-client
// activation-day reminder above stays UTC-based and untouched.
const SCHEDULE_TZ = 'Asia/Kolkata';

function zonedParts(now, timeZone = SCHEDULE_TZ) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) };
}

// Due when today (India) is the schedule's day — falling back to the month's
// last day when the month is shorter (day 31 fires on the 30th/28th) — and
// the hour has been reached (>=, not ==, so a server that was down at the
// exact hour still catches up later that day), and it hasn't run today.
function isScheduleDue(schedule, now = new Date()) {
  if (!schedule.enabled) return false;
  const { year, month, day, hour } = zonedParts(now);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day !== Math.min(schedule.day_of_month, lastDay)) return false;
  if (hour < schedule.send_hour) return false;
  return dateOnlyString(schedule.last_run_on) !== scheduleDateString(now);
}

function scheduleDateString(now = new Date()) {
  const { year, month, day } = zonedParts(now);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Per-schedule, side-effecting — the unit tests target (never the bulk loop,
// same reasoning as sendReminderIfDue). Returns null if not due / lost the
// claim, else { total, sent, failed, skipped }.
async function runScheduleIfDue(schedule, now = new Date(), db = pool) {
  if (!isScheduleDue(schedule, now)) return null;
  const today = scheduleDateString(now);
  const claimed = await paymentReminderSchedulesRepo.claimForDate(schedule.id, today);
  if (!claimed) return null;

  const clients = await clientsRepo.listActive(db);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const client of clients) {
    try {
      // Already reminded today (e.g. their own activation-day reminder fired
      // first) — don't message the same client twice in one day.
      if (dateOnlyString(client.last_reminder_sent_on) === today) { skipped += 1; continue; }
      const result = await paymentNotificationService.sendAndLog(client, {
        kind: 'payment_reminder', trigger: 'admin_schedule', name: 'wasi_payment_reminder',
        bodyParams: { client_name: client.name },
      });
      if (result.ok) sent += 1; else failed += 1;
      await clientsRepo.update(db, client.id, { last_reminder_sent_on: today });
    } catch (err) {
      failed += 1;
      console.error(`paymentReminderRunner: scheduled reminder failed for ${client.id} (${client.name}):`, err.message);
    }
  }
  const summary = `${clients.length} active: ${sent} sent, ${failed} failed, ${skipped} already reminded today`;
  await paymentReminderSchedulesRepo.recordSummary(schedule.id, summary);
  await auditLogRepo.record({
    actor_type: 'system', action: 'payment_reminder_schedule_ran',
    target: `day ${schedule.day_of_month} @ ${schedule.send_hour}:00 — ${summary}`,
  });
  return { total: clients.length, sent, failed, skipped };
}

async function runDueSchedules(now = new Date()) {
  const schedules = await paymentReminderSchedulesRepo.listEnabled();
  for (const schedule of schedules) {
    try {
      await runScheduleIfDue(schedule, now);
    } catch (err) {
      console.error(`paymentReminderRunner: schedule ${schedule.id} failed:`, err.message);
    }
  }
}

async function tick() {
  try {
    await runDueSchedules();
    await sendReminders();
    await enforceNonpayment();
  } catch (err) {
    console.error('paymentReminderRunner tick failed:', err.message);
  }
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
}
function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = {
  start, stop, tick,
  sendReminders, enforceNonpayment,
  sendReminderIfDue, enforceNonpaymentForClient,
  isScheduleDue, runScheduleIfDue, runDueSchedules, scheduleDateString,
  isReminderDueToday, daysSince, todayDateString, dateOnlyString,
  WARNING_AFTER_DAYS, SUSPEND_AFTER_DAYS,
};
