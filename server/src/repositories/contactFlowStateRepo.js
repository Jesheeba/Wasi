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

module.exports = { findActive, create, advance };
