const { pool } = require('../db/pool');

async function list(clientId, { since } = {}) {
  if (since) {
    const { rows } = await pool.query(
      'select * from chats where client_id = $1 and last_message_at > $2 order by last_message_at desc',
      [clientId, since]
    );
    return rows;
  }
  const { rows } = await pool.query(
    'select * from chats where client_id = $1 order by last_message_at desc',
    [clientId]
  );
  return rows;
}

async function findById(clientId, id) {
  const { rows } = await pool.query(
    'select * from chats where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rows[0] || null;
}

async function create(clientId, { name, phone, contact_id, tag_id, unread_count }) {
  const { rows } = await pool.query(
    `insert into chats (client_id, name, phone, contact_id, tag_id, unread_count)
     values ($1, $2, $3, $4, $5, coalesce($6, 0))
     returning *`,
    [clientId, name, phone, contact_id || null, tag_id || null, unread_count]
  );
  return rows[0];
}

// Used by inbound webhook ingestion: find the chat for a contact, or open a
// new one (mirrors what happens today when an agent manually starts a chat).
async function findOrCreateByContact(clientId, contact) {
  const { rows } = await pool.query(
    'select * from chats where client_id = $1 and contact_id = $2',
    [clientId, contact.id]
  );
  if (rows[0]) return rows[0];
  return create(clientId, { name: contact.name, phone: contact.phone, contact_id: contact.id, tag_id: contact.tag_id, unread_count: 0 });
}

async function update(clientId, id, fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return findById(clientId, id);

  const setClause = columns.map((col, i) => `${col} = $${i + 3}`).join(', ');
  const values = columns.map((col) => fields[col]);
  const { rows } = await pool.query(
    `update chats set ${setClause} where client_id = $1 and id = $2 returning *`,
    [clientId, id, ...values]
  );
  return rows[0] || null;
}

async function remove(clientId, id) {
  const { rowCount } = await pool.query(
    'delete from chats where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rowCount > 0;
}

async function listMessages(clientId, chatId, { since } = {}) {
  if (since) {
    const { rows } = await pool.query(
      'select * from messages where client_id = $1 and chat_id = $2 and sent_at > $3 order by sent_at asc',
      [clientId, chatId, since]
    );
    return rows;
  }
  const { rows } = await pool.query(
    'select * from messages where client_id = $1 and chat_id = $2 order by sent_at asc',
    [clientId, chatId]
  );
  return rows;
}

async function findMessageById(clientId, chatId, messageId) {
  const { rows } = await pool.query(
    'select * from messages where client_id = $1 and chat_id = $2 and id = $3',
    [clientId, chatId, messageId]
  );
  return rows[0] || null;
}

// The 24-hour customer service window: free-form text is only deliverable if
// the contact messaged in within the last 24h. No inbound message ever ->
// no window has ever been open -> template-only, same as an expired window.
async function lastInboundAt(clientId, chatId) {
  const { rows } = await pool.query(
    `select max(sent_at) as last_in from messages where client_id = $1 and chat_id = $2 and direction = 'in'`,
    [clientId, chatId]
  );
  return rows[0]?.last_in || null;
}

// Inserts the outbound row before the Cloud API call resolves (status
// 'pending'); messagingService updates it to sent/failed right after.
async function insertOutboundPending(clientId, chatId, body) {
  const { rows } = await pool.query(
    `insert into messages (chat_id, client_id, direction, body, status)
     values ($1, $2, 'out', $3, 'pending')
     returning *`,
    [chatId, clientId, body]
  );
  await pool.query(`update chats set last_message_at = now() where client_id = $1 and id = $2`, [clientId, chatId]);
  return rows[0];
}

async function markSent(clientId, messageId, metaMessageId) {
  const { rows } = await pool.query(
    `update messages set status = 'sent', meta_message_id = $3, error_reason = null
     where client_id = $1 and id = $2 returning *`,
    [clientId, messageId, metaMessageId]
  );
  return rows[0] || null;
}

async function markFailed(clientId, messageId, errorReason) {
  const { rows } = await pool.query(
    `update messages set status = 'failed', error_reason = $3
     where client_id = $1 and id = $2 returning *`,
    [clientId, messageId, errorReason]
  );
  return rows[0] || null;
}

// Idempotent inbound insert — Meta redelivers webhook events on retry/ack
// timeout, so a repeated meta_message_id is a no-op, not a duplicate message.
async function insertInbound(clientId, chatId, { metaMessageId, body, sentAt }) {
  const { rows } = await pool.query(
    `insert into messages (chat_id, client_id, direction, body, status, meta_message_id, sent_at)
     values ($1, $2, 'in', $3, 'delivered', $4, coalesce($5, now()))
     on conflict (meta_message_id) do nothing
     returning *`,
    [chatId, clientId, body, metaMessageId, sentAt || null]
  );
  if (rows[0]) {
    await pool.query(
      `update chats set last_message_at = now(), unread_count = unread_count + 1
       where client_id = $1 and id = $2`,
      [clientId, chatId]
    );
  }
  return rows[0] || null;
}

// Delivery/read/failed receipts arrive for a meta_message_id we may not have
// (send raced ahead of the webhook, or it's an inbound-message receipt we
// don't track) — a no-op update is expected, not an error.
async function updateStatusByMetaId(clientId, metaMessageId, status, errorReason) {
  const { rows } = await pool.query(
    `update messages set status = $3, error_reason = coalesce($4, error_reason)
     where client_id = $1 and meta_message_id = $2 returning *`,
    [clientId, metaMessageId, status, errorReason || null]
  );
  return rows[0] || null;
}

module.exports = {
  list,
  findById,
  create,
  findOrCreateByContact,
  update,
  remove,
  listMessages,
  findMessageById,
  lastInboundAt,
  insertOutboundPending,
  markSent,
  markFailed,
  insertInbound,
  updateStatusByMetaId,
};
