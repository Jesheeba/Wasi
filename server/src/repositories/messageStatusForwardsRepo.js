// Backs the idempotency guard in metaWebhook.js's handleStatuses — see
// migration 033_message_status_forwards.js for why this is a separate
// (meta_message_id, status) ledger rather than reusing messages' own
// meta_message_id uniqueness.
async function recordIfNew(db, metaMessageId, status) {
  const { rowCount } = await db.query(
    `insert into message_status_forwards (meta_message_id, status)
     values ($1, $2)
     on conflict (meta_message_id, status) do nothing`,
    [metaMessageId, status]
  );
  return rowCount > 0;
}

module.exports = { recordIfNew };
