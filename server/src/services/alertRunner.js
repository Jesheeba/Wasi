// Phase 6 Part C. Same shape as broadcastRunner.js/forwardRunner.js
// (idempotent start()/stop() over setInterval, one try/catch around the
// whole tick so a single check's failure can't take the others down or
// crash the process) — see those files for the reasoning behind that
// scaffold, unchanged here.
//
// Each check function returns candidate alerts for conditions true RIGHT
// NOW. reconcile() diffs that against what's currently open in alert_events
// per alert_type: newly-true conditions get inserted and notified; already-
// open ones just get last_seen_at touched (no repeat notification); open
// alerts whose condition no longer reproduces get resolved. This is what
// makes the runner idempotent across ticks without spamming — see
// migration 019_alerting.js's module comment for the DB-level half of this
// (the partial unique index).
const { pool } = require('../db/pool');
const alertEventsRepo = require('../repositories/alertEventsRepo');
const alertNotifier = require('../services/alertNotifier');
const metaClient = require('../utils/metaClient');
const consentRepo = require('../repositories/consentRepo');
const failedConsentWritesRepo = require('../repositories/failedConsentWritesRepo');

const TICK_MS = 5 * 60 * 1000;
const FAILED_SEND_SPIKE_THRESHOLD = 10;
const AUTH_CLASS_ERROR_CODES = [190, 10];

async function reconcile(alertType, candidates) {
  const dedupKeys = candidates.map((c) => c.dedupKey);
  for (const c of candidates) {
    const existing = await alertEventsRepo.findOpen(alertType, c.dedupKey);
    if (existing) {
      await alertEventsRepo.touch(existing.id);
      continue;
    }
    const created = await alertEventsRepo.open({ alertType, ...c });
    try {
      await alertNotifier.notify(created);
    } finally {
      // Marked notified even if the send itself failed — notify() already
      // swallows send errors per-channel (email/WhatsApp independently);
      // the alert_events row shouldn't be retried into an infinite
      // notify-loop just because a transient send failed once.
      await alertEventsRepo.markNotified(created.id);
    }
  }
  await alertEventsRepo.resolveStale(alertType, dedupKeys);
}

// 1. No successful webhook for a WABA in 24h that normally receives them —
// "normally receives" = has had at least one successful webhook ever, so a
// freshly connected number with zero history yet doesn't false-positive.
async function checkWebhookSilence() {
  const { rows } = await pool.query(`
    select w.id as waba_row_id, w.waba_id, c.name as client_name
    from wabas w
    join clients c on c.id = w.client_id
    where w.status = 'connected'
      and exists (
        select 1 from meta_webhook_log where success = true and w.id = any(waba_ids_touched)
      )
      and not exists (
        select 1 from meta_webhook_log
        where success = true and w.id = any(waba_ids_touched) and received_at > now() - interval '24 hours'
      )
  `);
  return rows.map((r) => ({
    dedupKey: r.waba_row_id,
    severity: 'critical',
    message: `No successful webhook received for ${r.client_name} (WABA ${r.waba_id}) in over 24 hours.`,
    details: r,
  }));
}

// 2. Sustained non-200 responses to Meta — before Meta disables the
// subscription entirely. Global (about our endpoint's own health), not
// per-tenant: the last 5 requests overall, all failed.
async function checkSustainedFailures() {
  const { rows } = await pool.query(
    `select success, received_at from meta_webhook_log order by received_at desc limit 5`
  );
  if (rows.length < 5 || rows.some((r) => r.success)) return [];
  return [{
    dedupKey: 'global',
    severity: 'critical',
    message: `The last 5 webhook deliveries from Meta all failed (non-200). Meta may disable this subscription if this continues.`,
    details: { recent: rows },
  }];
}

// 3. Any WABA restriction indicated by account_update.
async function checkWabaRestrictions() {
  const { rows } = await pool.query(`
    select w.id as waba_row_id, w.waba_id, w.restriction_status, c.name as client_name
    from wabas w join clients c on c.id = w.client_id
    where w.restriction_status is not null
  `);
  return rows.map((r) => ({
    dedupKey: r.waba_row_id,
    severity: 'critical',
    message: `${r.client_name}'s WABA (${r.waba_id}) has an active restriction.`,
    details: r,
  }));
}

// 4. Quality rating below green. Case-normalized — Meta's exact casing for
// this field was never confirmed against a live payload this session.
async function checkQualityRating() {
  const { rows } = await pool.query(`
    select w.id as waba_row_id, w.waba_id, w.quality_rating, c.name as client_name
    from wabas w join clients c on c.id = w.client_id
    where w.status = 'connected' and w.quality_rating is not null and upper(w.quality_rating) != 'GREEN'
  `);
  return rows.map((r) => ({
    dedupKey: r.waba_row_id,
    severity: 'warning',
    message: `${r.client_name}'s WABA (${r.waba_id}) quality rating is ${r.quality_rating}, not green. Quality is portfolio-level — this can affect every other client's messaging tier.`,
    details: r,
  }));
}

// 4b. Messaging tier near capacity. The fetch/populate work this file's own
// TODO used to point to now lives in services/messagingTierRefreshRunner.js
// (a fetch+persist job doesn't fit this file's pure check-then-alert shape —
// see that file's header comment for the reasoning). This check only reads
// what that runner has already written to wabas.messaging_tier — skips any
// waba with an unknown tier ('unknown'/null, never checked or Meta didn't
// return it) or TIER_UNLIMITED entirely, never fabricating urgency against a
// limit this app doesn't actually know.
const TIER_NEAR_CAPACITY_THRESHOLD = 0.9;
async function checkTierNearCapacity() {
  const { rows } = await pool.query(`
    select w.id as waba_row_id, w.waba_id, w.messaging_tier, c.name as client_name,
      (select count(distinct m.chat_id)::int from messages m
       where m.client_id = c.id and m.direction = 'out' and m.sent_at >= now() - interval '24 hours') as used_today
    from wabas w join clients c on c.id = w.client_id
    where w.status = 'connected' and w.messaging_tier is not null and w.messaging_tier != 'unknown'
  `);
  const alerts = [];
  for (const r of rows) {
    const cap = metaClient.messagingTierCap(r.messaging_tier);
    if (cap === null || cap === Infinity) continue;
    if (r.used_today >= cap * TIER_NEAR_CAPACITY_THRESHOLD) {
      alerts.push({
        dedupKey: r.waba_row_id,
        severity: 'warning',
        message: `${r.client_name}'s WABA (${r.waba_id}) has used ~${r.used_today} of its ${r.messaging_tier} tier's ${cap} conversations/24h — nearing capacity.`,
        details: r,
      });
    }
  }
  return alerts;
}

// 5. Any template paused or disabled.
async function checkTemplatesPausedOrDisabled() {
  const { rows } = await pool.query(`
    select t.id as template_id, t.name, t.status, t.client_id, c.name as client_name
    from message_templates t join clients c on c.id = t.client_id
    where t.status in ('paused', 'disabled')
  `);
  return rows.map((r) => ({
    dedupKey: r.template_id,
    severity: 'warning',
    message: `${r.client_name}'s template "${r.name}" is ${r.status}.`,
    details: r,
  }));
}

// 6. webhook_deliveries reaching terminal failed state — batched one alert
// per client per day, not one per row, so a fully-dead consuming-app
// endpoint doesn't flood.
async function checkWebhookDeliveryFailures() {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(`
    select wd.client_id, c.name as client_name, count(*)::int as failed_count
    from webhook_deliveries wd join clients c on c.id = wd.client_id
    where wd.status = 'failed'
    group by wd.client_id, c.name
  `);
  return rows.map((r) => ({
    dedupKey: `${r.client_id}:${today}`,
    severity: 'warning',
    message: `${r.client_name} has ${r.failed_count} webhook_deliveries in terminal failed state.`,
    details: r,
  }));
}

// 7a. Failed-send spike (global, threshold-based).
async function checkFailedSendSpike() {
  const { rows } = await pool.query(
    `select count(*)::int as failed_count from messages where status = 'failed' and sent_at > now() - interval '1 hour'`
  );
  const failedCount = rows[0].failed_count;
  if (failedCount < FAILED_SEND_SPIKE_THRESHOLD) return [];
  return [{
    dedupKey: 'global',
    severity: 'warning',
    message: `${failedCount} sends failed in the last hour across all clients (threshold: ${FAILED_SEND_SPIKE_THRESHOLD}).`,
    details: { failedCount },
  }];
}

// 7b. Any auth-class error (190, 10) — not threshold-based, fires on first
// occurrence per client per day (auth errors are rare and urgent; batched
// by day only so a fully-broken client's token doesn't send one email per
// message).
async function checkAuthClassErrors() {
  const { rows } = await pool.query(
    `select m.client_id, c.name as client_name, m.meta_error_code, count(*)::int as occurrence_count
     from messages m join clients c on c.id = m.client_id
     where m.meta_error_code = any($1::int[]) and m.sent_at > current_date
     group by m.client_id, c.name, m.meta_error_code`,
    [AUTH_CLASS_ERROR_CODES]
  );
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((r) => ({
    dedupKey: `${r.client_id}:${r.meta_error_code}:${today}`,
    severity: 'critical',
    message: `${r.client_name} has ${r.occurrence_count} auth-class send failure(s) (Meta error ${r.meta_error_code}) today — likely an expired/invalid token.`,
    details: r,
  }));
}

// 8. Consent hardening Phase 1 follow-up — replays failed_consent_writes.
// consentRepo.recordOptOutDurable falls back to writing here when even a
// retry fails; a row sitting here unresolved means a real customer said
// STOP and it's still not reflected in contacts.opt_in_status, so they
// could keep receiving marketing they opted out of. This is a mutation, not
// a pure condition check like the numbered checks above — it runs once per
// tick, BEFORE checkPendingFailedConsentWrites below, so a row fixed by
// this replay is already gone by the time that check builds its alert
// candidate list, and the alert can auto-resolve within the same tick a
// transient outage clears. Every row is independent (own try/catch) — one
// still-failing row must never block the rest of the batch from being
// retried.
async function replayFailedConsentWrites() {
  const pending = await failedConsentWritesRepo.listPending();
  for (const row of pending) {
    try {
      await consentRepo.recordEvent(row.client_id, row.contact_id, {
        event: row.event, source: row.source, evidence: row.evidence,
      });
      // Either the write now succeeded, or the contact no longer exists
      // (recordEvent's own not-found case resolves to null without
      // throwing) — both mean there is nothing further this row can
      // accomplish, so it's resolved either way.
      await failedConsentWritesRepo.resolve(row.id);
    } catch (err) {
      if (err instanceof consentRepo.ConsentBlockedError) {
        // Only reachable if this row's event were ever 'opted_in' — today
        // recordOptOutDurable only ever writes 'opted_out' rows here, so
        // this is defensive, not the expected path. It means the contact
        // has genuinely opted out since this row was written, by some
        // other route — a stronger, more current signal than this stale
        // pending write, so it's resolved as moot rather than retried
        // forever against a target state that would just get re-blocked.
        console.error(`alertRunner.replayFailedConsentWrites: row ${row.id} blocked — contact has opted out since; resolving as moot, not retrying:`, err.message);
        await failedConsentWritesRepo.resolve(row.id);
        continue;
      }
      // Still failing for the same (or a new) reason — leave it pending,
      // it gets another attempt next tick.
      console.error(`alertRunner.replayFailedConsentWrites: row ${row.id} still failing, left pending:`, err.message);
    }
  }
}

// 9. Any failed_consent_writes row still unresolved after the replay above
// — a real customer opt-out that is STILL not reflected in
// contacts.opt_in_status. Unlike chatSlaLogsRepo's own alertOnWriteFailure
// (left purely for a human to resolve, since nothing re-checks it), this
// alert auto-resolves via reconcile()'s existing resolveStale the moment
// replayFailedConsentWrites clears the last pending row — there IS now a
// real periodic re-check that can tell "is this still happening," so it
// should behave like every other condition-based check in this file, not
// like a one-off write failure. Deliberately a SEPARATE alert_type from
// consentRepo's own immediate 'consent_opt_out_write_failed' (raised the
// instant a write first fails, stays open until a human closes it — fast
// awareness of a fresh failure) — this one instead reflects ongoing
// backlog and clears itself; conflating the two would mean either losing
// the immediate ping or losing the auto-resolve.
async function checkPendingFailedConsentWrites() {
  const count = await failedConsentWritesRepo.countPending();
  if (count === 0) return [];
  return [{
    dedupKey: 'global',
    severity: 'critical',
    message: `${count} inbound WhatsApp opt-out(s) are still not recorded after retrying (failed_consent_writes) — the affected contact(s) may still receive marketing they opted out of. This is a compliance risk.`,
    details: { pendingCount: count },
  }];
}

async function maybeSendDailyDigest() {
  const today = new Date().toISOString().slice(0, 10);
  if (await alertEventsRepo.existsAny('daily_digest', today)) return;

  const [open, resolvedSince] = await Promise.all([
    alertEventsRepo.listOpen(),
    alertEventsRepo.listResolvedSince(new Date(Date.now() - 24 * 60 * 60 * 1000)),
  ]);
  const realOpen = open.filter((a) => a.alert_type !== 'daily_digest');
  const realResolved = resolvedSince.filter((a) => a.alert_type !== 'daily_digest');

  const message = realOpen.length === 0
    ? `Daily digest: all clear. No open alerts. ${realResolved.length} resolved in the last 24h.`
    : `Daily digest: ${realOpen.length} open alert(s) — ${realOpen.map((a) => a.alert_type).join(', ')}. ${realResolved.length} resolved in the last 24h.`;

  const created = await alertEventsRepo.open({
    alertType: 'daily_digest',
    dedupKey: today,
    severity: 'info',
    message,
    details: { open: realOpen, resolvedLast24h: realResolved },
  });
  try {
    await alertNotifier.notify(created);
  } finally {
    await alertEventsRepo.markNotified(created.id);
    // Not an ongoing condition — resolved immediately, existsAny() (not
    // findOpen()) is what makes this stay a once-a-day sent-marker.
    await alertEventsRepo.resolveNow(created.id);
  }
}

async function tick() {
  try {
    await reconcile('webhook_silence', await checkWebhookSilence());
    await reconcile('sustained_failures', await checkSustainedFailures());
    await reconcile('waba_restriction', await checkWabaRestrictions());
    await reconcile('quality_rating', await checkQualityRating());
    await reconcile('tier_near_capacity', await checkTierNearCapacity());
    await reconcile('template_paused_disabled', await checkTemplatesPausedOrDisabled());
    await reconcile('webhook_delivery_failures', await checkWebhookDeliveryFailures());
    await reconcile('failed_send_spike', await checkFailedSendSpike());
    await reconcile('auth_class_error', await checkAuthClassErrors());
    await replayFailedConsentWrites();
    await reconcile('consent_opt_out_pending_replay', await checkPendingFailedConsentWrites());
    await maybeSendDailyDigest();
  } catch (err) {
    console.error('alertRunner tick failed:', err.message);
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
  start,
  stop,
  tick,
  checkWebhookSilence,
  checkSustainedFailures,
  checkWabaRestrictions,
  checkQualityRating,
  checkTemplatesPausedOrDisabled,
  checkWebhookDeliveryFailures,
  checkFailedSendSpike,
  checkAuthClassErrors,
  replayFailedConsentWrites,
  checkPendingFailedConsentWrites,
};
