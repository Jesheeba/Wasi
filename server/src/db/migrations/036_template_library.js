// WhatsApp Template Message Library (wasi-master-plan.md §2) — a curated,
// admin-owned, read-only-to-clients set of pre-built template content a
// client can browse and one-click-prefill into the EXISTING template
// creation flow (routes/templates.js's POST /, messageTemplateCreateSchema)
// — this migration adds no new submission path, only reference content and
// a lightweight usage log.
//
// template_library is NOT a tenant table: it has no client_id and is not
// RLS-scoped — it's global content owned by Sirah's own admins (matching
// the "no full admin CMS in v1, seed via migration/script" scope from
// wasi-master-plan.md §2.6: this table is populated by
// server/src/db/seedTemplateLibrary.js, not through any admin UI yet), read
// by every client identically. template_library_usage DOES have client_id
// (which client used which library entry) and gets the same RLS treatment
// as every other tenant table since migration 013_tenant_isolation.js.
//
// header_type intentionally has no DB CHECK, same reasoning as
// message_templates.header_type (migration 020's comment): NONE/TEXT only
// are populated by the v1 seed content (a media header needs an uploaded
// file at submission time, which prefilling into the creation form can't
// supply without also building a media-hosting mechanism — out of scope
// here), enforced at the seed-script/route layer, not the DB, so adding
// media-header library entries later is a content/route change, not
// another migration.
//
// sample_values_json is keyed by param NAME (`{customer_name: "Priya"}`),
// matching message_templates.body_param_examples' shape exactly and this
// codebase's named-params-only convention (templateParams.js hard-rejects
// numbered {{1}}-style params) — never index-keyed.
//
// created_by_admin_id references admin_users(id) — NOT a table called
// "admins" (that name doesn't exist in this schema; admin_users is the
// live admin identity table, migration 002_platform_tables.js).
exports.up = (pgm) => {
  pgm.createTable('template_library', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    industry: { type: 'text', notNull: true },
    use_case: { type: 'text', notNull: true },
    category: { type: 'text', notNull: true, check: "category in ('Marketing', 'Utility', 'Authentication')" },
    title: { type: 'text', notNull: true },
    header_type: { type: 'text' },
    header_content: { type: 'text' },
    body: { type: 'text', notNull: true },
    footer: { type: 'text' },
    buttons_json: { type: 'jsonb' },
    sample_values_json: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    // 'en_US', not the wasi-master-plan.md draft's 'en' — matches
    // message_templates.language's real default and what Meta submission
    // actually requires (see server/src/utils/validate.js's
    // messageTemplateCreateSchema); the creation form's own language
    // picker still lets a client change it before submitting either way.
    language: { type: 'text', notNull: true, default: 'en_US' },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_by_admin_id: { type: 'uuid', references: 'admin_users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('template_library', ['industry', 'category']);
  pgm.createIndex('template_library', 'use_case');

  pgm.createTable('template_library_usage', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    library_template_id: { type: 'uuid', notNull: true, references: 'template_library', onDelete: 'CASCADE' },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('template_library_usage', 'client_id');
  pgm.createIndex('template_library_usage', 'library_template_id');

  pgm.sql('grant select on template_library to wasi_app');
  pgm.sql('grant select, insert on template_library_usage to wasi_app');

  pgm.sql('alter table template_library_usage enable row level security');
  pgm.sql('alter table template_library_usage force row level security');
  pgm.sql(`
    create policy tenant_isolation on template_library_usage
      using (client_id = nullif(current_setting('app.current_client_id', true), '')::uuid)
      with check (client_id = nullif(current_setting('app.current_client_id', true), '')::uuid)
  `);
};

exports.down = async (pgm) => {
  // Same discipline as migration 032_widen_forward_events.js's down(): this
  // is a real (shared dev/prod) database, so a rollback run any time after
  // real clients have actually clicked "Use this Template" would silently
  // destroy that usage history with a bare DROP TABLE. template_library
  // itself is safe to drop unconditionally — it's 100% reproducible from
  // seedTemplateLibrary.js (no admin-edit UI exists yet to lose, per
  // wasi-master-plan.md §2.6) — but template_library_usage is real
  // client-generated data. Check first and fail loudly with the count,
  // rather than either silently dropping it or a bare Postgres error.
  const [{ count }] = await pgm.db.select('select count(*)::int as count from template_library_usage');
  if (count > 0) {
    throw new Error(
      `Cannot roll back 036_template_library: template_library_usage has ${count} real ` +
      `row(s) recording actual client "Use this Template" activity. Export/back up this ` +
      `data first if it needs to be kept, then retry this rollback.`
    );
  }

  pgm.sql('drop policy if exists tenant_isolation on template_library_usage');
  pgm.sql('alter table template_library_usage disable row level security');
  pgm.dropTable('template_library_usage');
  pgm.dropTable('template_library');
};
