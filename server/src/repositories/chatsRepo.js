async function list(db, clientId, { since } = {}) {
  if (since) {
    const { rows } = await db.query(
      'select * from chats where client_id = $1 and last_message_at > $2 order by last_message_at desc',
      [clientId, since]
    );
    return rows;
  }
  const { rows } = await db.query(
    'select * from chats where client_id = $1 order by last_message_at desc',
    [clientId]
  );
  return rows;
}

async function findById(db, clientId, id) {
  const { rows } = await db.query(
    'select * from chats where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rows[0] || null;
}

async function create(db, clientId, { name, phone, contact_id, tag_id, unread_count }) {
  const { rows } = await db.query(
    `insert into chats (client_id, name, phone, contact_id, tag_id, unread_count)
     values ($1, $2, $3, $4, $5, coalesce($6, 0))
     returning *`,
    [clientId, name, phone, contact_id || null, tag_id || null, unread_count]
  );
  return rows[0];
}

// Used by inbound webhook ingestion and broadcastRunner (both privileged):
// find the chat for a contact, or open a new one (mirrors what happens today
// when an agent manually starts a chat).
async function findOrCreateByContact(db, clientId, contact) {
  const { rows } = await db.query(
    'select * from chats where client_id = $1 and contact_id = $2',
    [clientId, contact.id]
  );
  if (rows[0]) return rows[0];
  return create(db, clientId, { name: contact.name, phone: contact.phone, contact_id: contact.id, tag_id: contact.tag_id, unread_count: 0 });
}

async function update(db, clientId, id, fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return findById(db, clientId, id);

  const setClause = columns.map((col, i) => `${col} = $${i + 3}`).join(', ');
  const values = columns.map((col) => fields[col]);
  const { rows } = await db.query(
    `update chats set ${setClause} where client_id = $1 and id = $2 returning *`,
    [clientId, id, ...values]
  );
  return rows[0] || null;
}

async function remove(db, clientId, id) {
  const { rowCount } = await db.query(
    'delete from chats where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rowCount > 0;
}

async function listMessages(db, clientId, chatId, { since } = {}) {
  if (since) {
    const { rows } = await db.query(
      'select * from messages where client_id = $1 and chat_id = $2 and sent_at > $3 order by sent_at asc',
      [clientId, chatId, since]
    );
    return rows;
  }
  const { rows } = await db.query(
    'select * from messages where client_id = $1 and chat_id = $2 order by sent_at asc',
    [clientId, chatId]
  );
  return rows;
}

async function findMessageById(db, clientId, chatId, messageId) {
  const { rows } = await db.query(
    'select * from messages where client_id = $1 and chat_id = $2 and id = $3',
    [clientId, chatId, messageId]
  );
  return rows[0] || null;
}

// Hub API v1 (build plan Phase 5's MCP tool inventory, get_message_status) —
// unlike findMessageById above, the caller only has the message id, not its
// chat_id (a Hub API caller sends a message and gets back {id, ...} from
// POST /api/v1/messages; it doesn't separately track which chat that landed
// in). client_id alone is enough to scope this safely.
async function findMessageByIdForClient(db, clientId, messageId) {
  const { rows } = await db.query(
    'select * from messages where client_id = $1 and id = $2',
    [clientId, messageId]
  );
  return rows[0] || null;
}

// The 24-hour customer service window: free-form text is only deliverable if
// the contact messaged in within the last 24h. No inbound message ever ->
// no window has ever been open -> template-only, same as an expired window.
async function lastInboundAt(db, clientId, chatId) {
  const { rows } = await db.query(
    `select max(sent_at) as last_in from messages where client_id = $1 and chat_id = $2 and direction = 'in'`,
    [clientId, chatId]
  );
  return rows[0]?.last_in || null;
}

// Inserts the outbound row before the Cloud API call resolves (status
// 'pending'); messagingService updates it to sent/failed right after.
async function insertOutboundPending(db, clientId, chatId, body) {
  const { rows } = await db.query(
    `insert into messages (chat_id, client_id, direction, body, status)
     values ($1, $2, 'out', $3, 'pending')
     returning *`,
    [chatId, clientId, body]
  );
  await db.query(`update chats set last_message_at = now() where client_id = $1 and id = $2`, [clientId, chatId]);
  return rows[0];
}

async function markSent(db, clientId, messageId, metaMessageId) {
  const { rows } = await db.query(
    `update messages set status = 'sent', meta_message_id = $3, error_reason = null
     where client_id = $1 and id = $2 returning *`,
    [clientId, messageId, metaMessageId]
  );
  return rows[0] || null;
}

// metaErrorCode is Meta's numeric error code (err.metaError?.code from
// metaClient.js's graphFetch, e.g. 190/10 for auth-class errors) — optional
// since not every failure reaches Meta at all (a plan-limit or consent
// rejection never makes the API call), same reasoning messagingService.js's
// sendError.metaError already documents.
async function markFailed(db, clientId, messageId, errorReason, metaErrorCode) {
  const { rows } = await db.query(
    `update messages set status = 'failed', error_reason = $3, meta_error_code = $4
     where client_id = $1 and id = $2 returning *`,
    [clientId, messageId, errorReason, metaErrorCode || null]
  );
  return rows[0] || null;
}

// Idempotent inbound insert — Meta redelivers webhook events on retry/ack
// timeout, so a repeated meta_message_id is a no-op, not a duplicate message.
// Only ever called from metaWebhook.js, on the privileged connection.
async function insertInbound(db, clientId, chatId, { metaMessageId, body, sentAt }) {
  const { rows } = await db.query(
    `insert into messages (chat_id, client_id, direction, body, status, meta_message_id, sent_at)
     values ($1, $2, 'in', $3, 'delivered', $4, coalesce($5, now()))
     on conflict (meta_message_id) do nothing
     returning *`,
    [chatId, clientId, body, metaMessageId, sentAt || null]
  );
  if (rows[0]) {
    await db.query(
      `update chats set last_message_at = now(), unread_count = unread_count + 1
       where client_id = $1 and id = $2`,
      [clientId, chatId]
    );
  }
  return rows[0] || null;
}

// Delivery/read/failed receipts arrive for a meta_message_id we may not have
// (send raced ahead of the webhook, or it's an inbound-message receipt we
// don't track) — a no-op update is expected, not an error. Only ever called
// from metaWebhook.js, on the privileged connection.
async function updateStatusByMetaId(db, clientId, metaMessageId, status, errorReason, metaErrorCode) {
  const { rows } = await db.query(
    `update messages set status = $3, error_reason = coalesce($4, error_reason), meta_error_code = coalesce($5, meta_error_code)
     where client_id = $1 and meta_message_id = $2 returning *`,
    [clientId, metaMessageId, status, errorReason || null, metaErrorCode || null]
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
  findMessageByIdForClient,
  lastInboundAt,
  insertOutboundPending,
  markSent,
  markFailed,
  insertInbound,
  updateStatusByMetaId,
};
