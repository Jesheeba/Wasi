// Meta Official Template Library (wasi-master-plan.md §2b, build plan
// Phase 2b) — distinct from template_library (migration 036, the
// Wasi-authored curated one). This is a server-wide cache of Meta's OWN
// catalog (GET /message_template_library), which returns the exact same
// content for every Wasi client — not tenant data, no client_id, same
// "global reference content" treatment as template_library itself.
//
// Phase 0 investigation (real API research, not assumed) found two things
// that narrow this from what §2b's original draft assumed:
// 1. The create-from-library endpoint's own documentation states verbatim
//    "Must be UTILITY for use with Template Library" — category is fixed
//    to UTILITY, not "UTILITY and AUTHENTICATION" as originally drafted.
//    No CHECK constraint enforcing this (matches template_library's own
//    header_type precedent, migration 036's comment) — enforced at the
//    refresh-fetch/route layer instead, since v1's own fetch only ever
//    requests/stores UTILITY entries.
// 2. Catalog entries use classic positional {{1}}/{{2}} parameters — Wasi's
//    entire existing template pipeline (utils/templateParams.js) is
//    named-parameters-only and explicitly REJECTS positional params for
//    anything created through the normal flow. body_params is still stored
//    (jsonb array of Meta's own example values) so a future phase CAN widen
//    to support parameterized library templates without a schema change —
//    but v1 (Phase 0 decision) only ever surfaces/uses entries where this
//    array is empty, enforced at the route layer, not here.
//
// meta_library_id is Meta's own numeric template id from the catalog
// response (e.g. "7147013345418927") — kept distinct from this table's own
// uuid `id` (every other table's convention) so a natural lookup by Meta's
// identity is still possible without overloading the primary key's meaning.
//
// meta_template_library_refresh_meta is a single-row table (not a log) —
// v1 only needs "when did the last successful refresh happen," not history;
// a real audit trail is a reasonable later addition, not built here.
exports.up = (pgm) => {
  pgm.createTable('meta_template_library_cache', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    meta_library_id: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    category: { type: 'text', notNull: true },
    language: { type: 'text', notNull: true, default: 'en_US' },
    topic: { type: 'text' },
    usecase: { type: 'text' },
    industry: { type: 'jsonb' },
    header_text: { type: 'text' },
    body: { type: 'text', notNull: true },
    footer_text: { type: 'text' },
    buttons_json: { type: 'jsonb' },
    body_params: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('meta_template_library_cache', 'category');
  pgm.createIndex('meta_template_library_cache', 'usecase');

  pgm.createTable('meta_template_library_refresh_meta', {
    id: { type: 'boolean', primaryKey: true, default: true, check: 'id = true' },
    last_refreshed_at: { type: 'timestamptz' },
    last_refresh_entry_count: { type: 'integer' },
    last_refresh_error: { type: 'text' },
  });
  pgm.sql(`insert into meta_template_library_refresh_meta (id) values (true)`);

  pgm.sql('grant select on meta_template_library_cache to wasi_app');
  pgm.sql('grant select, update on meta_template_library_refresh_meta to wasi_app');
};

exports.down = (pgm) => {
  // Same as template_library (migration 036): 100% reproducible from a real
  // Meta refresh call, not client-authored content — safe to drop
  // unconditionally, no live-row guard needed.
  pgm.dropTable('meta_template_library_refresh_meta');
  pgm.dropTable('meta_template_library_cache');
};
