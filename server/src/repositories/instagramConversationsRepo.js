async function list(db, clientId) {
  const { rows } = await db.query(
    'select * from instagram_conversations where client_id = $1 order by last_message_at desc nulls last, created_at desc',
    [clientId]
  );
  return rows;
}

async function findById(db, clientId, id) {
  const { rows } = await db.query(
    'select * from instagram_conversations where client_id = $1 and id = $2',
    [clientId, id]
  );
  return rows[0] || null;
}

// Inbound webhook ingestion (privileged pool, not req.db — see metaWebhook.js)
// resolves a conversation by the pair Instagram itself gives it: which
// connected account received the DM, and the sender's IG-Scoped ID. Opens a
// new row on first contact, same shape as chatsRepo.findOrCreateByContact.
async function findOrCreateByIgScopedId(db, clientId, instagramAccountId, igScopedId, { igUsername, profilePicUrl } = {}) {
  const { rows } = await db.query(
    'select * from instagram_conversations where instagram_account_id = $1 and ig_scoped_id = $2',
    [instagramAccountId, igScopedId]
  );
  if (rows[0]) return rows[0];

  const inserted = await db.query(
    `insert into instagram_conversations (client_id, instagram_account_id, ig_scoped_id, ig_username, profile_pic_url)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [clientId, instagramAccountId, igScopedId, igUsername || null, profilePicUrl || null]
  );
  return inserted.rows[0];
}

async function touchLastMessageAt(db, id, incrementUnread) {
  const { rows } = await db.query(
    `update instagram_conversations
     set last_message_at = now(), unread_count = unread_count + $2
     where id = $1
     returning *`,
    [id, incrementUnread ? 1 : 0]
  );
  return rows[0] || null;
}

async function markRead(db, clientId, id) {
  const { rows } = await db.query(
    `update instagram_conversations set unread_count = 0 where client_id = $1 and id = $2 returning *`,
    [clientId, id]
  );
  return rows[0] || null;
}

module.exports = { list, findById, findOrCreateByIgScopedId, touchLastMessageAt, markRead };
