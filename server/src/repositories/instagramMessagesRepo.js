async function listByConversation(db, clientId, conversationId) {
  const { rows } = await db.query(
    'select * from instagram_messages where client_id = $1 and conversation_id = $2 order by sent_at asc',
    [clientId, conversationId]
  );
  return rows;
}

async function insertOutboundPending(db, clientId, conversationId, body) {
  const { rows } = await db.query(
    `insert into instagram_messages (conversation_id, client_id, direction, body, status)
     values ($1, $2, 'out', $3, 'pending')
     returning *`,
    [conversationId, clientId, body]
  );
  return rows[0];
}

async function markSent(db, clientId, messageId, metaMessageId) {
  const { rows } = await db.query(
    `update instagram_messages set status = 'sent', meta_message_id = $3, error_reason = null
     where client_id = $1 and id = $2 returning *`,
    [clientId, messageId, metaMessageId]
  );
  return rows[0] || null;
}

async function markFailed(db, clientId, messageId, errorReason) {
  const { rows } = await db.query(
    `update instagram_messages set status = 'failed', error_reason = $3
     where client_id = $1 and id = $2 returning *`,
    [clientId, messageId, errorReason]
  );
  return rows[0] || null;
}

// Idempotent inbound insert — Meta redelivers webhook events on retry/ack
// timeout, mirrors chatsRepo.insertInbound's on-conflict discipline. Only
// ever called from metaWebhook.js, on the privileged connection.
async function insertInbound(db, clientId, conversationId, body, metaMessageId) {
  const { rows } = await db.query(
    `insert into instagram_messages (conversation_id, client_id, direction, body, meta_message_id, status)
     values ($1, $2, 'in', $3, $4, 'received')
     on conflict (meta_message_id) do nothing
     returning *`,
    [conversationId, clientId, body, metaMessageId || null]
  );
  return rows[0] || null;
}

module.exports = { listByConversation, insertOutboundPending, markSent, markFailed, insertInbound };
