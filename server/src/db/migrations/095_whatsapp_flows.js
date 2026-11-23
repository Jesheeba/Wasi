// WhatsApp Flows ("Forms" in the UI) - build-docs/features/whatsapp-flows.md.
// Meta's native in-chat forms. Deliberately named whatsapp_flows, NOT flows:
// automation_flows (migration 023+) is this app's unrelated automation
// builder, and the two must never be confused in SQL either.
//
// whatsapp_flows: one row per form a client created from one of Wasi's
// authored kinds (lead / booking / survey). `config` holds the client's
// editable labels and options; `flow_json` is the exact JSON last uploaded to
// Meta, kept so what was published is always inspectable.
//
// whatsapp_flow_responses: one row per completed form (an nfm_reply inbound
// message). flow_id is nullable + SET NULL: a reply can arrive for a form
// deleted since, or built outside Wasi, and must still be kept.
//
// Both are tenant tables: wasi_app grant + RLS, same as contact_lists (039).
// The webhook writes responses on the privileged pool (it has no tenant
// context), so every query there scopes by client_id explicitly.
exports.up = (pgm) => {
  pgm.createTable('whatsapp_flows', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    kind: { type: 'text', notNull: true, check: "kind in ('lead', 'booking', 'survey')" },
    config: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    flow_json: { type: 'jsonb' },
    meta_flow_id: { type: 'text' },
    status: {
      type: 'text', notNull: true, default: 'draft',
      check: "status in ('draft', 'published', 'deprecated', 'blocked', 'throttled')",
    },
    last_error: { type: 'text' },
    published_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('whatsapp_flows', 'client_id');
  pgm.createIndex('whatsapp_flows', ['client_id', 'meta_flow_id'], { unique: true, where: 'meta_flow_id is not null' });

  pgm.createTable('whatsapp_flow_responses', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    flow_id: { type: 'uuid', references: 'whatsapp_flows', onDelete: 'SET NULL' },
    chat_id: { type: 'uuid', references: 'chats', onDelete: 'SET NULL' },
    contact_id: { type: 'uuid', references: 'contacts', onDelete: 'SET NULL' },
    meta_message_id: { type: 'text' },
    flow_token: { type: 'text' },
    response: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('whatsapp_flow_responses', ['client_id', 'created_at']);
  pgm.createIndex('whatsapp_flow_responses', 'flow_id');
  // A redelivered webhook must not store the same submission twice.
  pgm.createIndex('whatsapp_flow_responses', ['client_id', 'meta_message_id'], { unique: true, where: 'meta_message_id is not null' });

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  for (const table of ['whatsapp_flows', 'whatsapp_flow_responses']) {
    pgm.sql(`grant select, insert, update, delete on ${table} to wasi_app`);
    pgm.sql(`alter table ${table} enable row level security`);
    pgm.sql(`alter table ${table} force row level security`);
    pgm.sql(`create policy tenant_isolation on ${table} using (client_id = ${setting}) with check (client_id = ${setting})`);
  }
};

// Clients' real forms and submissions could exist by the time this runs on
// a shared database: refuse with the count instead of dropping them.
exports.down = async (pgm) => {
  const [{ count }] = await pgm.db.select(
    'select (select count(*) from whatsapp_flows) + (select count(*) from whatsapp_flow_responses) as count'
  );
  if (Number(count) > 0) {
    throw new Error(`Cannot roll back 095_whatsapp_flows: ${count} real form/submission row(s) exist. Export or delete them first.`);
  }
  pgm.dropTable('whatsapp_flow_responses');
  pgm.dropTable('whatsapp_flows');
};
