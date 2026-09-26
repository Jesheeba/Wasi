// Instagram DM Automation, Phase 1 — inbox storage, deliberately parallel to
// chats/messages rather than a channel-column retrofit onto them. Those
// tables are phone-identity-keyed throughout (contacts.phone UNIQUE per
// client, messagingService.sendChatMessage reads chat.phone directly as the
// Graph API recipient) — an Instagram contact's identity is an IG-Scoped ID
// (IGSID), not a phone number, so reusing the same tables would need real
// schema surgery on a production pipeline this codebase's own history shows
// is fragile. Ordinary tenant tables otherwise — no access token stored
// here, so (unlike instagram_accounts/wabas) full CRUD is granted to
// wasi_app, same treatment as chat_notes (migration 057).
exports.up = (pgm) => {
  pgm.createTable('instagram_conversations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    instagram_account_id: { type: 'uuid', notNull: true, references: 'instagram_accounts', onDelete: 'CASCADE' },
    ig_scoped_id: { type: 'text', notNull: true },
    ig_username: { type: 'text' },
    profile_pic_url: { type: 'text' },
    last_message_at: { type: 'timestamptz' },
    unread_count: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('instagram_conversations', 'client_id');
  pgm.addConstraint('instagram_conversations', 'instagram_conversations_account_igsid_unique', {
    unique: ['instagram_account_id', 'ig_scoped_id'],
  });

  pgm.createTable('instagram_messages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    conversation_id: { type: 'uuid', notNull: true, references: 'instagram_conversations', onDelete: 'CASCADE' },
    direction: { type: 'text', notNull: true, check: "direction in ('in', 'out')" },
    body: { type: 'text' },
    meta_message_id: { type: 'text' },
    status: { type: 'text' },
    error_reason: { type: 'text' },
    sent_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('instagram_messages', 'client_id');
  pgm.createIndex('instagram_messages', 'conversation_id');
  // Mirrors messages.messages_meta_message_id_unique (migration 006) —
  // Postgres treats multiple NULLs as distinct, so this only rejects a
  // genuine duplicate delivery of the same Meta-assigned message id, and
  // is what instagramMessagesRepo.insertInbound's ON CONFLICT targets for
  // idempotent redelivery handling.
  pgm.addConstraint('instagram_messages', 'instagram_messages_meta_message_id_unique', {
    unique: ['meta_message_id'],
  });

  pgm.sql(`grant select, insert, update, delete on instagram_conversations to wasi_app`);
  pgm.sql(`grant select, insert, update, delete on instagram_messages to wasi_app`);

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  for (const table of ['instagram_conversations', 'instagram_messages']) {
    pgm.sql(`alter table ${table} enable row level security`);
    pgm.sql(`alter table ${table} force row level security`);
    pgm.sql(`
      create policy tenant_isolation on ${table}
        using (client_id = ${setting})
        with check (client_id = ${setting})
    `);
  }
};

exports.down = async (pgm) => {
  const [{ count }] = await pgm.db.select('select count(*)::int as count from instagram_messages');
  if (count > 0) {
    throw new Error(
      `Cannot roll back 082_instagram_conversations_messages: ${count} real message(s) exist. ` +
      `Export/back up first if they need to be kept, then retry this rollback.`
    );
  }

  for (const table of ['instagram_messages', 'instagram_conversations']) {
    pgm.sql(`drop policy if exists tenant_isolation on ${table}`);
    pgm.sql(`alter table ${table} disable row level security`);
    pgm.sql(`revoke all on ${table} from wasi_app`);
  }

  pgm.dropTable('instagram_messages');
  pgm.dropTable('instagram_conversations');
};
