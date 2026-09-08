// Fans a broadcast out to every contact matching its audience tag (or every
// contact, if no tag was set — a "send to everyone" campaign). client_id is
// stamped directly onto each recipient row (not just reachable via
// broadcast_id -> broadcasts.client_id) so it can carry its own RLS policy
// like every other tenant table, instead of needing a join-based one.
//
// Real bug, fixed (Option B, per explicit review): this used to match ONLY
// contacts.tag_id (the single "primary tag"), which no contact-editing UI
// has ever written — items 8/8.5's multi-tag chip picker only ever writes
// the separate, additive contact_tags table. A contact tagged VIP via that
// picker silently matched zero recipients when "VIP" was picked as a
// broadcast audience. Fixed by matching EITHER source — never REPLACING
// tag_id with contact_tags only (Option A), since contacts.tag_id has one
// other real, live write path (the Automation Flow Builder's "Assign Tag"
// action node, flowEngine.js) that this fix must not regress. The OR is
// scoped to the ONE tag being targeted, so this can never over-match: a
// contact tagged X via one mechanism and Y via the other still only
// matches an audience of X or an audience of Y, never both from one pick.
async function createFromAudience(db, broadcastId, clientId, tagId) {
  // Joins back to contacts.opt_in_status in the same statement — the
  // caller (routes/broadcasts.js) needs it immediately, to warn before any
  // send happens, not just to insert the rows.
  const { rows } = await db.query(
    `with inserted as (
       insert into broadcast_recipients (broadcast_id, client_id, contact_id)
       select $1, $2, id from contacts
       where client_id = $2
         and ($3::uuid is null or tag_id = $3 or exists (
           select 1 from contact_tags ct where ct.contact_id = contacts.id and ct.tag_id = $3
         ))
       returning *
     )
     select inserted.*, contacts.opt_in_status
     from inserted
     join contacts on contacts.id = inserted.contact_id`,
    [broadcastId, clientId, tagId || null]
  );
  return rows;
}

// Same shape and same "returns opt_in_status immediately for the caller's
// pre-send consent warning" reasoning as createFromAudience above — the
// only difference is the source of contact ids (list membership instead of
// a tag match).
async function createFromList(db, broadcastId, clientId, contactListId) {
  const { rows } = await db.query(
    `with inserted as (
       insert into broadcast_recipients (broadcast_id, client_id, contact_id)
       select $1, $2, clm.contact_id
       from contact_list_members clm
       join contact_lists cl on cl.id = clm.contact_list_id
       where cl.id = $3 and cl.client_id = $2
       returning *
     )
     select inserted.*, contacts.opt_in_status
     from inserted
     join contacts on contacts.id = inserted.contact_id`,
    [broadcastId, clientId, contactListId]
  );
  return rows;
}

// PLAN.md item 9 — a third audience source alongside createFromAudience
// (tag_id) and createFromList (contact_list_id) above. filterSql/
// filterParams come from utils/segmentFilter.js's compileFilter, called by
// the caller (routes/broadcasts.js) with paramOffset: 2 ($1/$2 are
// broadcastId/clientId here, so the filter's own placeholders continue
// from $3). Same shape and same "returns opt_in_status immediately for the
// caller's pre-send consent warning" reasoning as the two functions above.
async function createFromSegment(db, broadcastId, clientId, filterSql, filterParams) {
  const { rows } = await db.query(
    `with inserted as (
       insert into broadcast_recipients (broadcast_id, client_id, contact_id)
       select $1, $2, id from contacts where client_id = $2 and (${filterSql})
       returning *
     )
     select inserted.*, contacts.opt_in_status
     from inserted
     join contacts on contacts.id = inserted.contact_id`,
    [broadcastId, clientId, ...filterParams]
  );
  return rows;
}

// broadcastRunner-only from here down — always the privileged connection,
// since a single tick processes recipients across every client's broadcasts
// concurrently (see build plan Phase 3 investigation notes in migration
// 013_tenant_isolation.js). `db` here is a transaction-scoped client
// (claimBatch runs inside processBroadcast's own BEGIN/COMMIT), not the pool.
//
// Atomically claims a batch of pending (or stuck-in-flight, see below) rows
// for exactly this broadcast, via a CTE, not `UPDATE ... WHERE id IN
// (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)`. Precise finding, not a
// vague "known footgun" claim — this project's own independent Auditor
// initially could NOT reproduce a LIMIT violation for the plain WHERE-IN
// form against a local Postgres 16 instance (single-call and 10-way
// concurrent, both correct). Re-verified directly against THIS app's real
// database (Supabase-managed Postgres 17.6, confirmed via `select
// version()`) with 3 repeated trials of each form on identical data: the
// WHERE-IN form deterministically claimed all 5 pending rows for
// limit=1 in every trial; the CTE form below deterministically claimed
// exactly 1 in every trial. This is a real, reproducible PG17-specific (or
// PG17-plus-Supavisor-pooler-specific — not further isolated) behavior
// difference for this exact query shape, not a flaky/rare occurrence and
// not a testing artifact — confirmed on the actual deployment target, which
// is what matters here regardless of the local-PG16 result. Invisible
// before Phase 3 (wasi-master-plan.md §8.3) only because the previous
// constant BATCH_SIZE=25 rarely bound against real pending counts, not
// because it didn't exist — Phase 3's smaller per-broadcast pacing limits
// are what made the symptom observable. The CTE form materializes the
// SELECT ... LIMIT ... FOR UPDATE SKIP LOCKED result as its own statement
// first, then the UPDATE joins onto exactly that already-limited set — the
// standard, textbook-correct pattern for a SKIP LOCKED work queue
// regardless of this version-specific finding. Once this commits no other
// tick (this process or a future multi-instance one) can claim the same
// rows — unlike a plain SELECT ... FOR UPDATE, whose lock releases at
// commit while the rows are still 'pending' and re-claimable. Also
// reclaims rows stuck in 'sending' for >5 minutes (a crash between claim
// and markSent/markFailed) rather than abandoning them forever.
async function claimBatch(db, broadcastId, limit) {
  const { rows } = await db.query(
    `with claimed as (
       select id from broadcast_recipients
       where broadcast_id = $1
         and (status = 'pending' or (status = 'sending' and claimed_at < now() - interval '5 minutes'))
       order by created_at asc
       limit $2
       for update skip locked
     )
     update broadcast_recipients
     set status = 'sending', claimed_at = now()
     from claimed
     where broadcast_recipients.id = claimed.id
     returning broadcast_recipients.*`,
    [broadcastId, limit]
  );
  if (rows.length === 0) return [];

  const contactIds = rows.map((r) => r.contact_id).filter(Boolean);
  const { rows: contacts } = await db.query(
    `select id, name, phone, tag_id from contacts where id = any($1::uuid[])`,
    [contactIds]
  );
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const withContact = rows.map((r) => ({
    ...r,
    contact_name: byId.get(r.contact_id)?.name,
    contact_phone: byId.get(r.contact_id)?.phone,
    contact_tag_id: byId.get(r.contact_id)?.tag_id,
  }));

  // Contact deleted mid-flight (contact_id -> SET NULL, migration 007) has
  // nowhere to send — real, previously-silent bug found during Phase 3 QA:
  // this row was claimed (status='sending') above but then simply filtered
  // out of the returned batch, never resolved to a terminal status. Since
  // hasPending() treats 'sending' as not-done, the parent broadcast could
  // never reach 'Completed', and the >5-minute stuck-reclaim clause in this
  // same function's WHERE clause would re-claim (and re-filter) it forever —
  // an unbounded loop, not just a missed send. Resolved to 'failed' here,
  // in the same transaction as the claim, so it's terminal immediately.
  const orphaned = withContact.filter((r) => !r.contact_phone);
  if (orphaned.length > 0) {
    await db.query(
      `update broadcast_recipients set status = 'failed', error_reason = 'Contact was deleted before this recipient could be sent.' where id = any($1::uuid[])`,
      [orphaned.map((r) => r.id)]
    );
  }

  return withContact.filter((r) => r.contact_phone);
}

async function markSent(db, id, messageId) {
  await db.query(
    `update broadcast_recipients set status = 'sent', message_id = $2, error_reason = null where id = $1`,
    [id, messageId]
  );
}

async function markFailed(db, id, errorReason) {
  await db.query(
    `update broadcast_recipients set status = 'failed', error_reason = $2 where id = $1`,
    [id, errorReason]
  );
}

// Distinct from markFailed on purpose (build plan Phase 4) — a non-opted-in
// recipient is never attempted, so it isn't a send failure. Reported
// separately on the broadcast (see broadcastsRepo.list's skipped_count).
async function markSkipped(db, id, reason) {
  await db.query(
    `update broadcast_recipients set status = 'skipped', error_reason = $2 where id = $1`,
    [id, reason]
  );
}

async function hasPending(db, broadcastId) {
  const { rows } = await db.query(
    `select 1 from broadcast_recipients where broadcast_id = $1 and status in ('pending', 'sending') limit 1`,
    [broadcastId]
  );
  return rows.length > 0;
}

// PLAN.md item 12 — Smart Sending. Called from broadcastRunner.js
// (privileged `pool`, not req.db — same as claimBatch above) before a send
// actually goes out, against ANY of this contact's OTHER broadcast sends
// client-wide, not just this one broadcast — "already received another
// broadcast recently" is the point, not "sent twice by the same campaign"
// (a single campaign never targets one contact twice to begin with).
// broadcast_recipients has no send timestamp of its own (created_at is row
// creation, not send time) — the real send time is only reachable via the
// linked message's sent_at, same join shape as item 10's timeline query.
// `hours` is bound as a number multiplying a fixed interval literal, never
// concatenated into the query text.
async function hasRecentSend(db, clientId, contactId, hours) {
  const { rows } = await db.query(
    `select exists (
       select 1 from broadcast_recipients br
       join messages m on m.id = br.message_id
       where br.client_id = $1 and br.contact_id = $2 and br.status = 'sent'
         and m.sent_at > now() - ($3::numeric * interval '1 hour')
     ) as has_recent`,
    [clientId, contactId, hours]
  );
  return rows[0].has_recent;
}

module.exports = { createFromAudience, createFromList, createFromSegment, claimBatch, markSent, markFailed, markSkipped, hasPending, hasRecentSend };
