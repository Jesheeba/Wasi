// PLAN.md item 4 — canned responses (`/slash` commands). Reusable
// shortcut -> message-body snippets, autocompleted in the chat input.
// Independent of items 2/3 structurally (no FK to chats/team_members) —
// only depends on item 1 for role gating at the route layer. Same
// tenant-table treatment as every other client-scoped table (migration
// 013's pattern): RLS enabled+forced, full CRUD granted to wasi_app.
exports.up = (pgm) => {
  pgm.createTable('canned_responses', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    shortcut: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('canned_responses', 'canned_responses_client_shortcut_unique', {
    unique: ['client_id', 'shortcut'],
  });
  pgm.createIndex('canned_responses', 'client_id');

  pgm.sql(`grant select, insert, update, delete on canned_responses to wasi_app`);

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql(`alter table canned_responses enable row level security`);
  pgm.sql(`alter table canned_responses force row level security`);
  pgm.sql(`
    create policy tenant_isolation on canned_responses
      using (client_id = ${setting})
      with check (client_id = ${setting})
  `);
};

exports.down = async (pgm) => {
  // Same discipline as migrations 032/036/039/040/046's down()s — a real
  // client's saved shortcuts could exist by the time a rollback runs on
  // this shared database.
  const [{ count }] = await pgm.db.select('select count(*)::int as count from canned_responses');
  if (count > 0) {
    throw new Error(
      `Cannot roll back 058_canned_responses: ${count} real canned response(s) exist. ` +
      `Export/back up first if they need to be kept, then retry this rollback.`
    );
  }

  pgm.sql(`drop policy if exists tenant_isolation on canned_responses`);
  pgm.sql(`alter table canned_responses disable row level security`);
  pgm.sql(`revoke all on canned_responses from wasi_app`);
  pgm.dropTable('canned_responses');
};
