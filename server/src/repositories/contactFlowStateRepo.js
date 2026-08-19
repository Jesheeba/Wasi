async function findActive(db, clientId, contactId) {
  const { rows } = await db.query(
    `select * from contact_flow_state
     where client_id = $1 and contact_id = $2 and status in ('active', 'processing')`,
    [clientId, contactId]
  );
  return rows[0] || null;
}

// Starts a new flow for a contact. The partial unique index
// (contact_flow_state_one_active_per_contact, migration 023) is the real
// concurrency guard: if two inbound events for the same contact both try to
// start a flow at nearly the same moment, the second INSERT throws a
// unique_violation (Postgres code 23505) — flowEngine.js treats that as
// "someone else already won," not an error.
async function create(db, { clientId, contactId, flowId, currentNodeId }) {
  const { rows } = await db.query(
    `insert into contact_flow_state (client_id, contact_id, flow_id, current_node_id)
     values ($1, $2, $3, $4)
     returning *`,
    [clientId, contactId, flowId, currentNodeId]
  );
  return rows[0];
}

// Compare-and-swap advance — an atomic UPDATE...RETURNING, not a held row
// lock (see migration 023's module comment for why: holding a Postgres lock
// across the Meta API call flowEngine.js makes between reading and writing
// state would repeat the exact anti-pattern forwardRunner.js exists to
// avoid). Returns null, not a throw, if expectedNodeId/expectedVersion no
// longer match current — a concurrent webhook delivery or flowRunner
// (Stage 4) already moved this contact past the state this call was
// computed against. The caller logs that as 'superseded' and does nothing
// further; it must never retry blindly, since re-running the node's send
// would double-message the contact.
async function advance(db, { clientId, contactId, expectedNodeId, expectedVersion, nodeId, status, dueAt, waitingSince }) {
  const { rows } = await db.query(
    `update contact_flow_state
     set current_node_id = $5, status = $6, due_at = $7, waiting_since = $8,
         version = version + 1, updated_at = now()
     where client_id = $1 and contact_id = $2 and status = 'active'
       and current_node_id = $3 and version = $4
     returning *`,
    [clientId, contactId, expectedNodeId, expectedVersion, nodeId, status, dueAt || null, waitingSince || null]
  );
  return rows[0] || null;
}

// flowRunner.js's claim — same atomic UPDATE...WHERE...SKIP LOCKED...RETURNING
// shape as broadcastRecipientsRepo.claimBatch, flipping 'active' -> 'processing'
// in the same statement so the claim and the visibility change are atomic.
// This is also what makes the webhook path's CAS advance() race-safe for
// free (advance() requires status = 'active'; once a row is 'processing'
// here, that WHERE clause simply won't match, 0 rows, safe no-op) — see
// flowEngine.js's module comment. Also reclaims rows stuck in 'processing'
// for >5 minutes (a crash between claim and finalizeProcessing), same
// pattern broadcastRecipientsRepo.claimBatch uses for 'sending'.
async function claimDueBatch(db, limit) {
  const { rows } = await db.query(
    `update contact_flow_state
     set status = 'processing', updated_at = now()
     where id in (
       select id from contact_flow_state
       where (status = 'active' and due_at is not null and due_at <= now())
          or (status = 'processing' and updated_at < now() - interval '5 minutes')
       order by due_at asc nulls last, updated_at asc
       limit $1
       for update skip locked
     )
     returning *`,
    [limit]
  );
  return rows;
}

// flowRunner.js's finalize — unlike advance(), this doesn't need a version
// check: a 'processing' row was exclusively claimed by exactly one
// claimDueBatch call (SKIP LOCKED), so nothing else can be concurrently
// finalizing the same row. status = 'processing' in the WHERE clause is
// still required, though — it's what stops this from ever finalizing a row
// the webhook path has since raced ahead of (impossible while 'processing',
// but this must never silently overwrite an unrelated state).
async function finalizeProcessing(db, { clientId, contactId, expectedNodeId, nodeId, status, dueAt, waitingSince }) {
  const { rows } = await db.query(
    `update contact_flow_state
     set current_node_id = $4, status = $5, due_at = $6, waiting_since = $7,
         version = version + 1, updated_at = now()
     where client_id = $1 and contact_id = $2 and status = 'processing' and current_node_id = $3
     returning *`,
    [clientId, contactId, expectedNodeId, nodeId, status, dueAt || null, waitingSince || null]
  );
  return rows[0] || null;
}

module.exports = { findActive, create, advance, claimDueBatch, finalizeProcessing };
