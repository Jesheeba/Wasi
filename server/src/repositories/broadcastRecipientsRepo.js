// Fans a broadcast out to every contact matching its audience tag (or every
// contact, if no tag was set — a "send to everyone" campaign). client_id is
// stamped directly onto each recipient row (not just reachable via
// broadcast_id -> broadcasts.client_id) so it can carry its own RLS policy
// like every other tenant table, instead of needing a join-based one.
async function createFromAudience(db, broadcastId, clientId, tagId) {
  // Joins back to contacts.opt_in_status in the same statement — the
  // caller (routes/broadcasts.js) needs it immediately, to warn before any
  // send happens, not just to insert the rows.
  const { rows } = await db.query(
    `with inserted as (
       insert into broadcast_recipients (broadcast_id, client_id, contact_id)
       select $1, $2, id from contacts where client_id = $2 and ($3::uuid is null or tag_id = $3)
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

// broadcastRunner-only from here down — always the privileged connection,
// since a single tick processes recipients across every client's broadcasts
// concurrently (see build plan Phase 3 investigation notes in migration
// 013_tenant_isolation.js). `db` here is a transaction-scoped client
// (claimBatch runs inside processBroadcast's own BEGIN/COMMIT), not the pool.
//
// Atomically claims a batch of pending (or stuck-in-flight, see below) rows
// for exactly this broadcast, via a CTE, not `UPDATE ... WHERE id IN
// (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` — that shape is a known
// Postgres footgun: found live during Phase 3 (wasi-master-plan.md §8.3)
// when a small per-broadcast pacing limit (down from the previous constant
// BATCH_SIZE=25) made the bug's symptom actually observable — the plain
// WHERE-IN-subquery form does NOT reliably respect its own LIMIT once
// wrapped in the outer UPDATE (confirmed directly: limit=1 against 5 real
// pending rows claimed all 5, not 1). This was a real, silent, pre-existing
// bug — invisible before Phase 3 only because BATCH_SIZE=25 rarely bound
// against real pending counts, not because it didn't exist. The CTE form
// below materializes the SELECT ... LIMIT ... FOR UPDATE SKIP LOCKED result
// as its own statement first, then the UPDATE joins onto exactly that
// already-limited set — the standard, correct pattern for a SKIP LOCKED
// work queue. Once this commits no other tick (this process or a future
// multi-instance one) can claim the same rows — unlike a plain
// SELECT ... FOR UPDATE, whose lock releases at commit while the rows are
// still 'pending' and re-claimable. Also reclaims rows stuck in 'sending'
// for >5 minutes (a crash between claim and markSent/markFailed) rather
// than abandoning them forever.
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

module.exports = { createFromAudience, createFromList, claimBatch, markSent, markFailed, markSkipped, hasPending };
