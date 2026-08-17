const { pool } = require('../db/pool');

// Fans a broadcast out to every contact matching its audience tag (or every
// contact, if no tag was set — a "send to everyone" campaign).
async function createFromAudience(broadcastId, clientId, tagId) {
  // Joins back to contacts.opt_in_status in the same statement — the
  // caller (routes/broadcasts.js) needs it immediately, to warn before any
  // send happens, not just to insert the rows.
  const { rows } = await pool.query(
    `with inserted as (
       insert into broadcast_recipients (broadcast_id, contact_id)
       select $1, id from contacts where client_id = $2 and ($3::uuid is null or tag_id = $3)
       returning *
     )
     select inserted.*, contacts.opt_in_status
     from inserted
     join contacts on contacts.id = inserted.contact_id`,
    [broadcastId, clientId, tagId || null]
  );
  return rows;
}

// Atomically claims a batch of pending (or stuck-in-flight, see below) rows
// for exactly this broadcast: the UPDATE ... WHERE id IN (SELECT ... FOR
// UPDATE SKIP LOCKED) sets status='sending' inside the same statement, so
// once this commits no other tick (this process or a future multi-instance
// one) can claim the same rows — unlike a plain SELECT ... FOR UPDATE, whose
// lock releases at commit while the rows are still 'pending' and re-claimable.
// Also reclaims rows stuck in 'sending' for >5 minutes (a crash between claim
// and markSent/markFailed) rather than abandoning them forever.
async function claimBatch(client, broadcastId, limit) {
  const { rows } = await client.query(
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
  const { rows: contacts } = await client.query(
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

async function markSent(id, messageId) {
  await pool.query(
    `update broadcast_recipients set status = 'sent', message_id = $2, error_reason = null where id = $1`,
    [id, messageId]
  );
}

async function markFailed(id, errorReason) {
  await pool.query(
    `update broadcast_recipients set status = 'failed', error_reason = $2 where id = $1`,
    [id, errorReason]
  );
}

// Distinct from markFailed on purpose (build plan Phase 4) — a non-opted-in
// recipient is never attempted, so it isn't a send failure. Reported
// separately on the broadcast (see broadcastsRepo.list's skipped_count).
async function markSkipped(id, reason) {
  await pool.query(
    `update broadcast_recipients set status = 'skipped', error_reason = $2 where id = $1`,
    [id, reason]
  );
}

async function hasPending(broadcastId) {
  const { rows } = await pool.query(
    `select 1 from broadcast_recipients where broadcast_id = $1 and status in ('pending', 'sending') limit 1`,
    [broadcastId]
  );
  return rows.length > 0;
}

module.exports = { createFromAudience, claimBatch, markSent, markFailed, markSkipped, hasPending };
