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

// broadcastRunner-only from here down — always the privileged connection,
// since a single tick processes recipients across every client's broadcasts
// concurrently (see build plan Phase 3 investigation notes in migration
// 013_tenant_isolation.js). `db` here is a transaction-scoped client
// (claimBatch runs inside processBroadcast's own BEGIN/COMMIT), not the pool.
//
// Atomically claims a batch of pending (or stuck-in-flight, see below) rows
// for exactly this broadcast: the UPDATE ... WHERE id IN (SELECT ... FOR
// UPDATE SKIP LOCKED) sets status='sending' inside the same statement, so
// once this commits no other tick (this process or a future multi-instance
// one) can claim the same rows — unlike a plain SELECT ... FOR UPDATE, whose
// lock releases at commit while the rows are still 'pending' and re-claimable.
// Also reclaims rows stuck in 'sending' for >5 minutes (a crash between claim
// and markSent/markFailed) rather than abandoning them forever.
async function claimBatch(db, broadcastId, limit) {
  const { rows } = await db.query(
    `update broadcast_recipients
     set status = 'sending', claimed_at = now()
     where id in (
       select id from broadcast_recipients
       where broadcast_id = $1
         and (status = 'pending' or (status = 'sending' and claimed_at < now() - interval '5 minutes'))
       order by created_at asc
       limit $2
       for update skip locked
     )
     returning *`,
    [broadcastId, limit]
  );
  if (rows.length === 0) return [];

  const contactIds = rows.map((r) => r.contact_id).filter(Boolean);
  const { rows: contacts } = await db.query(
    `select id, name, phone, tag_id from contacts where id = any($1::uuid[])`,
    [contactIds]
  );
  const byId = new Map(contacts.map((c) => [c.id, c]));
  return rows
    .map((r) => ({
      ...r,
      contact_name: byId.get(r.contact_id)?.name,
      contact_phone: byId.get(r.contact_id)?.phone,
      contact_tag_id: byId.get(r.contact_id)?.tag_id,
    }))
    .filter((r) => r.contact_phone); // contact deleted mid-flight (contact_id -> SET NULL) has nowhere to send
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

module.exports = { createFromAudience, claimBatch, markSent, markFailed, markSkipped, hasPending };
