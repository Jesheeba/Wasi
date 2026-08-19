// Append-only, mirrors consentRepo's consent_events pattern — the audit
// trail for "what did this contact's flow do," read by the contact/chat
// detail view (stall visibility) and Stage 5's super-admin failures view.
async function record(db, { clientId, contactId, flowId, nodeId, eventType, detail }) {
  await db.query(
    `insert into flow_events (client_id, contact_id, flow_id, node_id, event_type, detail)
     values ($1, $2, $3, $4, $5, $6)`,
    [clientId, contactId, flowId, nodeId || null, eventType, detail ? JSON.stringify(detail) : '{}']
  );
}

module.exports = { record };
