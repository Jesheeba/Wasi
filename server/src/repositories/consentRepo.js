const { pool } = require('../db/pool');
const failedConsentWritesRepo = require('./failedConsentWritesRepo');
const alertEventsRepo = require('./alertEventsRepo');
const alertNotifier = require('../services/alertNotifier');

// Consent hardening Phase 1 — thrown by recordEvent when an 'opted_in' event
// arrives for a contact whose CURRENT status is already 'opted_out'. Opt-out
// is sticky: once a contact has opted out, nothing writes them back to
// opted_in except the contact themselves (Phase 4's planned START keyword,
// its own new source). A bulk/CSV/flow-driven opt-in silently overwriting a
// real STOP is exactly the compliance failure this whole hardening pass
// exists to close — so this is a thrown error, not a quiet no-op, and every
// caller must decide how to surface it (routes/contacts.js -> 409;
// flowEngine's set_opt_in -> its own existing generic node-failure handling
// in runToRest, which stalls the flow and records why, rather than silently
// continuing as if the override had worked).
class ConsentBlockedError extends Error {
  constructor(contactId) {
    super(`Contact ${contactId} has opted out — only the contact themselves can undo that (e.g. replying START), not a bulk/CSV/flow opt-in.`);
    this.code = 'opted_out_is_sticky';
    this.contactId = contactId;
  }
}

// The only writer of contacts.opt_in_status/opt_in_source/opt_in_at/opt_out_at
// — every other place that touches a contact (contactCreateSchema,
// contactUpdateSchema, the generic PATCH route) deliberately excludes these
// columns. A consent change always means both the contact's current state
// updates AND an immutable consent_events row gets appended in the same
// transaction — one without the other would leave either a status with no
// evidence, or evidence that never took effect.
//
// actorType/actorId/batchId (migration 077) are optional and default to
// null — every existing caller keeps working unchanged; routes/contacts.js
// and a future bulk/CSV writer pass req.actorType/req.actorId (same
// vocabulary chats.js already uses: 'owner' with actorId null, or
// 'team_member' with the team member's id) and a shared batchId for a
// multi-row action.
//
// Deliberately NOT converted to the `db`-first-param convention (see
// tagsRepo.js) — this function manages its own atomic transaction, and its
// caller on the client-request path (routes/contacts.js) already runs
// inside the tenantContext middleware's own transaction on req.db. Reusing
// that connection here would mean a nested BEGIN (a no-op warning, not a
// real nested transaction) and a COMMIT/ROLLBACK that would prematurely end
// the *whole request's* transaction, not just this one write. Simpler and
// correct to keep this self-contained on its own privileged connection —
// the two writes inside are still atomic with each other, just not part of
// the outer request transaction.
async function recordEvent(clientId, contactId, { event, source, evidence, actorType, actorId, batchId } = {}) {
  const client = await pool.connect();
  // Named handler, removed before release() — pg.Pool reuses the same
  // underlying Client object across separate connect()/release() cycles, so
  // an `.on('error', ...)` that's never removed accumulates one listener per
  // call on whichever client happens to be reused, eventually tripping
  // Node's MaxListenersExceededWarning. Found live via Phase 2's bulk
  // opt-in, which calls this once per contact in a request (hundreds at
  // once) — the exact same class of bug broadcastRunner.js's own
  // processBroadcast already hit and fixed first; this mirrors that fix.
  const onClientError = (err) => console.error('consentRepo: checked-out client error (non-fatal):', err.message);
  client.on('error', onClientError);
  try {
    await client.query('BEGIN');

    // Locks the row before deciding anything — without this, a concurrent
    // inbound STOP and an in-flight bulk opt-in could each read the
    // pre-write status and both proceed, the bulk write landing after the
    // STOP's and silently re-opting-in a contact who just opted out. The
    // lock makes the two writes serialize; whichever commits second sees
    // the other's result.
    const { rows: locked } = await client.query(
      `select opt_in_status from contacts where client_id = $1 and id = $2 for update`,
      [clientId, contactId]
    );
    if (!locked[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    if (event === 'opted_in' && locked[0].opt_in_status === 'opted_out') {
      throw new ConsentBlockedError(contactId);
    }

    const statusColumn = event === 'opted_in' ? 'opt_in_at' : 'opt_out_at';
    const { rows } = await client.query(
      `update contacts
       set opt_in_status = $3, opt_in_source = $4, ${statusColumn} = now()
       where client_id = $1 and id = $2
       returning *`,
      [clientId, contactId, event === 'opted_in' ? 'opted_in' : 'opted_out', source]
    );

    await client.query(
      `insert into consent_events (client_id, contact_id, event, source, evidence, actor_type, actor_id, batch_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [clientId, contactId, event, source, evidence ? JSON.stringify(evidence) : null, actorType || null, actorId || null, batchId || null]
    );

    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.removeListener('error', onClientError);
    client.release();
  }
}

// The one caller of this is metaWebhook.js's inbound STOP handling — an
// opt-out recorded there has no human on the other end to retry it
// themselves the way a client re-clicking a button in the UI effectively
// would, so a lost write is a compliance failure (evidence of a customer's
// real objection, gone), not just a UX inconvenience. Two total attempts
// (one retry), immediate/no delay between them — most transient DB errors
// are a momentary connection blip, and adding a real sleep here would add
// that same delay to the webhook response Meta is waiting on. If both
// attempts fail, the attempt is written to failed_consent_writes (never
// silently gone — migration 078's module comment; alertRunner.js's
// replayFailedConsentWrites retries it again on a 5-minute cycle, so a
// transient outage self-heals without waiting on a human) and a deduped
// alert is raised via the existing alertEventsRepo/alertNotifier
// infrastructure, same shape chatSlaLogsRepo.alertOnWriteFailure already
// established for "the write failed, don't lose it, don't spam."
//
// `phone` is accepted separately from `evidence` (metaWebhook.js passes it
// explicitly) specifically so the last-resort log line at the bottom always
// has it, rather than depending on the caller's evidence shape containing
// it — phone is exactly the detail a human would need to manually follow up
// on this specific customer if every automated path below also failed.
//
// Every stage below is its own try/catch and this function never throws —
// it already runs inside metaWebhook's own inbound-message handling, which
// must never 500 back to Meta over a consent bookkeeping failure (that
// would just make Meta retry the whole webhook delivery). The harder case
// this handles explicitly: failedConsentWritesRepo.record uses the SAME
// database recordEvent just failed against, so if the database itself is
// down, the durable-write fallback fails too — it must not be the only
// place an opt-out could still get recorded. On that specific failure this
// still (a) attempts the DB-backed alert path (dedup/open/notify), and if
// THAT also fails because the DB is unreachable, (b) falls back to calling
// alertNotifier.notify directly with no DB dependency at all — email/
// WhatsApp delivery itself doesn't need the app's own database — so a total
// DB outage still reaches a human, just without dedup (impossible without
// the DB to check against). Either way, (c) the full opt-out detail
// (client, contact, phone, time) is always console.error'd once at the end,
// unconditionally, as a last-resort trace independent of whether anything
// above landed anywhere.
async function recordOptOutDurable(clientId, contactId, { source, evidence, phone }) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await recordEvent(clientId, contactId, { event: 'opted_out', source, evidence });
    } catch (err) {
      lastErr = err;
      console.error(`consentRepo.recordOptOutDurable: attempt ${attempt}/2 failed:`, err.message);
    }
  }

  let durableWriteSucceeded = false;
  try {
    await failedConsentWritesRepo.record({
      clientId, contactId, event: 'opted_out', source, evidence, errorMessage: lastErr.message,
    });
    durableWriteSucceeded = true;
  } catch (writeErr) {
    console.error('consentRepo.recordOptOutDurable: durable fallback write ALSO failed (same database as the write itself — likely a full DB outage):', writeErr.message);
  }

  const ALERT_TYPE = 'consent_opt_out_write_failed';
  const DEDUP_KEY = 'global';
  // Shaped to match what alertNotifier.notify() itself reads (severity,
  // alert_type, message, details — see its own module comment) — used
  // directly as the last-resort payload below, and spread with alertType/
  // dedupKey added for alertEventsRepo.open()'s different key names.
  const alertPayload = {
    severity: 'critical',
    alert_type: ALERT_TYPE,
    message: 'An inbound WhatsApp opt-out (STOP) could not be recorded after retrying — see the failed_consent_writes table for the durable copy of what was attempted. This is a compliance risk, not just a missing-data gap.',
    details: { clientId, contactId, phone: phone || null, source, error: lastErr.message, durableWriteSucceeded },
  };
  let alerted = false;
  try {
    const existing = await alertEventsRepo.findOpen(ALERT_TYPE, DEDUP_KEY);
    if (existing) {
      await alertEventsRepo.touch(existing.id);
      alerted = true; // already notified when first opened — touching is the correct behavior, not a fresh notify
    } else {
      const created = await alertEventsRepo.open({ ...alertPayload, alertType: ALERT_TYPE, dedupKey: DEDUP_KEY });
      try {
        await alertNotifier.notify(created);
        alerted = true;
      } finally {
        await alertEventsRepo.markNotified(created.id);
      }
    }
  } catch (dbAlertErr) {
    // The DB-backed path itself failed (most likely: the database is fully
    // unreachable, the same reason the write and the durable fallback both
    // failed above). Dedup is impossible without the DB to check against —
    // this branch always sends its own real notification rather than
    // silently giving up, since a real customer's opt-out is on the line.
    console.error('consentRepo.recordOptOutDurable: DB-backed alerting failed — falling back to a direct notify with no DB dependency:', dbAlertErr.message);
    try {
      await alertNotifier.notify(alertPayload);
      alerted = true;
    } catch (lastResortErr) {
      console.error('consentRepo.recordOptOutDurable: last-resort direct alertNotifier.notify ALSO failed:', lastResortErr.message);
    }
  }

  // Unconditional — printed regardless of whether the durable write or the
  // alert succeeded, so there is always at least one trace of this specific
  // opt-out attempt even in a total-outage scenario where nothing above
  // landed anywhere.
  console.error('CONSENT OPT-OUT WRITE FAILED — last-resort record:', {
    clientId, contactId, phone: phone || null, event: 'opted_out', source, evidence,
    error: lastErr.message, durableWriteSucceeded, alerted, at: new Date().toISOString(),
  });

  return null;
}

async function listEventsForContact(db, clientId, contactId) {
  const { rows } = await db.query(
    'select * from consent_events where client_id = $1 and contact_id = $2 order by created_at desc',
    [clientId, contactId]
  );
  return rows;
}

module.exports = { recordEvent, recordOptOutDurable, listEventsForContact, ConsentBlockedError };
