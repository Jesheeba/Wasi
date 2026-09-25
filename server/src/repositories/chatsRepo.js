// assignedTo (PLAN.md item 2's queue filters, resolved by the route layer
// before this is called — 'me' is already translated to the caller's real
// actorId, this function never needs to know what "me" means):
//   'unassigned' -> assigned_team_member_id is null
//   a uuid       -> assigned_team_member_id = that id
//   undefined    -> no filter (matches every existing caller unchanged)
async function list(db, clientId, { since, status, assignedTo } = {}) {
  const conditions = ['client_id = $1'];
  const params = [clientId];

  if (since) {
    params.push(since);
    conditions.push(`last_message_at > $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (assignedTo === 'unassigned') {
    conditions.push('assigned_team_member_id is null');
  } else if (assignedTo) {
    params.push(assignedTo);
    conditions.push(`assigned_team_member_id = $${params.length}`);
  }

  const { rows } = await db.query(
    `select * from chats where ${conditions.join(' and ')} order by last_message_at desc`,
    params
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

// PLAN.md item 5 — unlike lastInboundAt above (a timestamp only, for the
// 24h session-window check), SLA tracking needs the inbound message's own
// id to key chat_sla_logs' dedup-per-cycle mechanism. Returns null for a
// chat with no inbound message at all (e.g. an owner-originated
// conversation) — callers treat that as "nothing to measure," not an error.
async function findLastInboundMessage(db, clientId, chatId) {
  const { rows } = await db.query(
    `select * from messages where client_id = $1 and chat_id = $2 and direction = 'in' order by sent_at desc limit 1`,
    [clientId, chatId]
  );
  return rows[0] || null;
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
// sendError.metaError already documents. metaErrorSubcode (migration
// 073_messages_error_subcode.js) is the same story one level deeper — a
// single code like #200 covers several distinct causes distinguished only
// by err.metaError?.error_subcode.
async function markFailed(db, clientId, messageId, errorReason, metaErrorCode, metaErrorSubcode) {
  const { rows } = await db.query(
    `update messages set status = 'failed', error_reason = $3, meta_error_code = $4, meta_error_subcode = $5
     where client_id = $1 and id = $2 returning *`,
    [clientId, messageId, errorReason, metaErrorCode || null, metaErrorSubcode || null]
  );
  return rows[0] || null;
}

// Idempotent inbound insert — Meta redelivers webhook events on retry/ack
// timeout, so a repeated meta_message_id is a no-op, not a duplicate message.
// Only ever called from metaWebhook.js, on the privileged connection.
//
// A new inbound message reopens a resolved chat (PLAN.md item 2 follow-up,
// found via direct question, not originally specified) — living here rather
// than in a route means it applies to every inbound path, not just one.
// assigned_team_member_id is deliberately left untouched on reopen, not
// nulled: chats.assigned_team_member_id already has ON DELETE SET NULL
// (migration 045), so a deleted assignee's reference is cleared the moment
// they're deleted, independent of resolve/reopen state — there is no
// "resolved chat holding a stale assignment" state to strand. There's also
// no disabled-but-not-deleted team_members status in this schema (only
// invited/active), so there's no other ghost-assignee case to guard
// against. GET /api/chats?assignedTo=me carries no status filter unless the
// caller adds one, so a reopened chat with its assignment intact
// immediately reappears in the assignee's own queue, not just Admin/
// Manager's unfiltered view.
// PLAN.md item 14 — referral is Meta's documented CTWA (Click-to-WhatsApp
// ad) object, present only on a message that originated from an ad click;
// null for every organic inbound message. Stored verbatim (source_url,
// source_type, source_id, headline, body, media_type, image_url/video_url,
// ctwa_clid) — this app never edits or interprets its shape beyond reading
// it back, so no per-field columns.
async function insertInbound(db, clientId, chatId, { metaMessageId, body, sentAt, referral }) {
  const { rows } = await db.query(
    `insert into messages (chat_id, client_id, direction, body, status, meta_message_id, sent_at, referral)
     values ($1, $2, 'in', $3, 'delivered', $4, coalesce($5, now()), $6)
     on conflict (meta_message_id) do nothing
     returning *`,
    [chatId, clientId, body, metaMessageId, sentAt || null, referral ? JSON.stringify(referral) : null]
  );
  if (rows[0]) {
    await db.query(
      `update chats
       set last_message_at = now(),
           unread_count = unread_count + 1,
           status = case when status = 'resolved' then 'open' else status end
       where client_id = $1 and id = $2`,
      [clientId, chatId]
    );
  }
  return rows[0] || null;
}

// Coexistence echo ingestion (smb_message_echoes) — a message the BUSINESS
// sent from their own phone (the WhatsApp Business app), which this app
// never originated and never called Meta to send. Deliberately its own
// function, not a variant of insertInbound (direction is 'in' there,
// unconditionally) or insertOutboundPending (hardcodes status='pending' on
// the assumption a later markSent/markFailed call is coming from THIS app's
// own send path — for an echo, nothing will ever call either, since the
// send already fully happened on the phone before we ever heard about it;
// reusing insertOutboundPending would leave the row stuck showing "sending"
// forever). Idempotent on the echo's own Meta-assigned id, same on-conflict
// pattern as insertInbound, so a redelivered webhook can't duplicate a row.
// Sets chats.unread_count = 0, not "does not touch it" — this is a
// deliberate product call, not the original draft's assumption. An echo is
// proof the business already saw and answered the thread from their own
// phone; leaving unread_count alone would show a client who handles
// everything on their phone a badge for conversations they've already
// answered, which is the exact "this inbox is wrong" feeling this whole
// build exists to fix. This is a real, narrow exception to the invariant
// app.js's own comment (around its unread_count=0 PATCH) documents —
// "chats.unread_count only ever increments server-side [on an inbound
// message]; the client zeroes it" — an echo is the one case where the
// SERVER now has direct proof of resolution without any client ever
// opening the chat, so it zeroes it here instead of waiting for a PATCH
// that may never come if the client keeps answering entirely from their
// phone. Deliberately zeroes rather than decrements — an echo means the
// whole thread up to this point has been addressed, not just this one
// message. Chat creation/lookup for a not-yet-seen contact is the caller's
// job (mirrors handleInboundMessages' own contactsRepo.upsertByPhone +
// findOrCreateByContact sequence), not this function's —
// findOrCreateByContact already covers "a business can start a conversation
// from their phone."
async function insertEcho(db, clientId, chatId, { metaMessageId, body, sentAt, source = 'whatsapp_app' }) {
  const { rows } = await db.query(
    `insert into messages (chat_id, client_id, direction, body, status, meta_message_id, sent_at, source)
     values ($1, $2, 'out', $3, 'delivered', $4, coalesce($5, now()), $6)
     on conflict (meta_message_id) do nothing
     returning *`,
    [chatId, clientId, body, metaMessageId, sentAt || null, source]
  );
  if (rows[0]) {
    await db.query(
      `update chats set last_message_at = now(), unread_count = 0 where client_id = $1 and id = $2`,
      [clientId, chatId]
    );
  }
  return rows[0] || null;
}

// Monotonic status guard, added 2026-09-25 — not echo-specific (WhatsApp
// status webhooks aren't guaranteed to arrive in order for any outbound
// message, echo or otherwise), but flagged as urgent by the coexistence
// work: an echo now starts life at 'delivered' immediately (insertEcho),
// skipping 'sent' entirely, so a later 'sent' webhook Meta still emits for
// that same id would previously have silently regressed the row and lied
// to the client's UI about whether their message actually landed.
//
// Covers the complete value set messages.status has ever allowed (migration
// 006's own CHECK constraint, unchanged since): 'sent' -> 'delivered' ->
// 'read' is a strict ladder that never moves backwards — an incoming status
// at or below the row's current rank is logged, not written. 'failed' is a
// separate terminal branch, not on the ladder: it's only accepted while the
// row isn't already 'delivered'/'read' (a message Meta already confirmed
// delivered cannot subsequently fail — seeing that combination is logged as
// an anomaly, not applied as a state change: no status write, no
// error_reason/meta_error_code write, no failed_at stamp). 'pending' is
// never accepted from a webhook at all — Meta's real status webhooks only
// ever report sent/delivered/read/failed; 'pending' only ever comes from
// insertOutboundPending, before any webhook has run.
const STATUS_LADDER_RANK = { sent: 1, delivered: 2, read: 3 };

// Pure and separately testable (no DB stubbing needed) — see
// server/test/messageStatusMonotonicGuard.test.js.
function decideStatusTransition(currentStatus, incomingStatus) {
  if (incomingStatus === 'pending') {
    return { accept: false, reason: `status webhook reported 'pending', which Meta never sends — ignoring` };
  }
  if (incomingStatus === 'failed') {
    if (currentStatus === 'delivered' || currentStatus === 'read') {
      return { accept: false, reason: `'failed' arrived after the row was already '${currentStatus}' — treating as anomalous, not changing status` };
    }
    return { accept: true };
  }
  const incomingRank = STATUS_LADDER_RANK[incomingStatus];
  const currentRank = STATUS_LADDER_RANK[currentStatus] || 0;
  // An incoming status this ladder doesn't recognize (not one of the 5
  // values messages.status has ever allowed) is accepted as-is, same as
  // before this guard existed — never silently drop a genuinely new value.
  if (incomingRank === undefined) return { accept: true };
  if (incomingRank <= currentRank) {
    return {
      accept: false,
      reason: incomingRank < currentRank
        ? `out-of-order status '${incomingStatus}' arrived while already '${currentStatus}' — recording the event, not moving the row backwards`
        : undefined, // an exact repeat (e.g. a redelivered 'sent' after 'sent') is a normal no-op, not worth logging
    };
  }
  return { accept: true };
}

// Delivery/read/failed receipts arrive for a meta_message_id we may not have
// (send raced ahead of the webhook, or it's an inbound-message receipt we
// don't track) — a no-op update is expected, not an error. Only ever called
// from metaWebhook.js, on the privileged connection.
async function updateStatusByMetaId(db, clientId, metaMessageId, status, errorReason, metaErrorCode) {
  const { rows: existingRows } = await db.query(
    'select status from messages where client_id = $1 and meta_message_id = $2',
    [clientId, metaMessageId]
  );
  if (existingRows.length === 0) return null;

  const decision = decideStatusTransition(existingRows[0].status, status);
  if (decision.reason) {
    console.warn(`metaWebhook: ${decision.reason}`, { clientId, metaMessageId, currentStatus: existingRows[0].status, incomingStatus: status });
  }

  const newStatus = decision.accept ? status : existingRows[0].status;
  // A blocked 'failed' (decision.accept === false for status === 'failed')
  // must not write error_reason/meta_error_code/failed_at either — the row
  // is staying 'delivered'/'read', so persisting failure detail against it
  // would contradict its own status. Every other accepted transition
  // behaves exactly as before this guard existed.
  const recordFailureDetail = decision.accept && status === 'failed';

  // delivered_at/read_at: stamped only the first time a message reaches
  // that status (coalesce keeps the original time on a duplicate webhook
  // delivery, which Meta is known to send) — see migration
  // 072_messages_status_timestamps.js for why these exist at all. Keyed on
  // the INCOMING status, not the guard's decision — a late 'delivered'
  // arriving after 'read' is already recorded still proves delivery
  // happened, even though the ladder correctly keeps the headline status at
  // 'read'.
  const { rows } = await db.query(
    `update messages set
       status = $3,
       error_reason = case when $7 then coalesce($4, error_reason) else error_reason end,
       meta_error_code = case when $7 then coalesce($5, meta_error_code) else meta_error_code end,
       delivered_at = case when $6 = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
       read_at = case when $6 = 'read' then coalesce(read_at, now()) else read_at end,
       failed_at = case when $7 then coalesce(failed_at, now()) else failed_at end
     where client_id = $1 and meta_message_id = $2 returning *`,
    [clientId, metaMessageId, newStatus, errorReason || null, metaErrorCode || null, status, recordFailureDetail]
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
  findLastInboundMessage,
  insertOutboundPending,
  markSent,
  markFailed,
  insertInbound,
  insertEcho,
  updateStatusByMetaId,
  decideStatusTransition,
};
