// PLAN.md item 3 — internal notes with @mention. A per-chat note thread
// visible only to team members, never sent to the customer (no relation to
// `messages`, which is the real WhatsApp conversation). Same tenant-table
// treatment as every other client-scoped table (migration 013's pattern):
// RLS enabled+forced, full CRUD granted to wasi_app.
//
// author_team_member_id is nullable (ON DELETE SET NULL, not a hard
// requirement) for two real reasons: the client account itself (the
// "owner", not a team_members row at all) can author a note too, and a
// team member who's later deleted shouldn't take their historical notes
// with them — the note stays, attribution just clears.
//
// mentioned_team_member_ids is a plain uuid[], not FK-constrained (Postgres
// can't FK an array column) — the write-time app-layer check (every id
// really belongs to this client, before insert) is what enforces integrity
// here, same discipline as item 2's assign endpoint validating teamMemberId
// before writing it.
exports.up = (pgm) => {
  pgm.createTable('chat_notes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    chat_id: { type: 'uuid', notNull: true, references: 'chats', onDelete: 'CASCADE' },
    author_team_member_id: { type: 'uuid', references: 'team_members', onDelete: 'SET NULL' },
    body: { type: 'text', notNull: true },
    mentioned_team_member_ids: { type: 'uuid[]', notNull: true, default: pgm.func("'{}'::uuid[]") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('chat_notes', 'client_id');
  pgm.createIndex('chat_notes', 'chat_id');

  pgm.sql(`grant select, insert, update, delete on chat_notes to wasi_app`);

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql(`alter table chat_notes enable row level security`);
  pgm.sql(`alter table chat_notes force row level security`);
  pgm.sql(`
    create policy tenant_isolation on chat_notes
      using (client_id = ${setting})
      with check (client_id = ${setting})
  `);
};

exports.down = async (pgm) => {
  // Same discipline as migrations 032/036/039/040's down()s — a real
  // client's team could have written real internal notes by the time a
  // rollback runs on this shared database; silently dropping them loses
  // real conversation context with no warning.
  const [{ count }] = await pgm.db.select('select count(*)::int as count from chat_notes');
  if (count > 0) {
    throw new Error(
      `Cannot roll back 046_chat_notes: ${count} real internal note(s) exist. ` +
      `Export/back up first if they need to be kept, then retry this rollback.`
    );
  }

  pgm.sql(`drop policy if exists tenant_isolation on chat_notes`);
  pgm.sql(`alter table chat_notes disable row level security`);
  pgm.sql(`revoke all on chat_notes from wasi_app`);
  pgm.dropTable('chat_notes');
};
