// Media-header template support (creation + sending). Media headers
// (IMAGE/VIDEO/DOCUMENT) are now a separate concern from header_type/
// header_content, which stay as-is for TEXT headers — see migration
// 020_template_rich_fields.js for why header_type was deliberately left
// unconstrained: this is the "later" that comment referred to.
//
// template_media_cache is NOT a media library (no browsing, no reuse across
// templates — that's explicitly out of scope, see the media-header
// investigation report). It exists because sending a media-header template
// requires a `media id` from Meta's standard Media API, distinct from the
// `header_handle` used at template creation time (Resumable Upload API) —
// and that media id expires after 30 days while a template can stay in use
// indefinitely. One row per template caches the current media id; Meta
// itself is the file store for refresh (services/mediaHeaderService.js
// downloads the media back via GET /{media-id} before the 30-day window
// closes and re-uploads it to mint a fresh id) — nothing here persists the
// original file bytes.
exports.up = (pgm) => {
  pgm.createTable('template_media_cache', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    // One cached media id per template — a second resolve for the same
    // template updates this row rather than inserting another.
    template_id: { type: 'uuid', notNull: true, references: 'message_templates', onDelete: 'CASCADE', unique: true },
    media_id: { type: 'text', notNull: true },
    // Recommended (not required) by Meta for a document header send, so a
    // client's PDF shows a real filename instead of an opaque one. Null for
    // IMAGE/VIDEO, where it's not applicable.
    filename: { type: 'text' },
    resolved_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('template_media_cache', 'client_id');

  pgm.sql(`grant select, insert, update, delete on template_media_cache to wasi_app`);

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql(`alter table template_media_cache enable row level security`);
  pgm.sql(`alter table template_media_cache force row level security`);
  pgm.sql(`
    create policy tenant_isolation on template_media_cache
      using (client_id = ${setting})
      with check (client_id = ${setting})
  `);
};

exports.down = (pgm) => {
  pgm.sql(`drop policy if exists tenant_isolation on template_media_cache`);
  pgm.sql(`alter table template_media_cache disable row level security`);
  pgm.sql(`revoke all on template_media_cache from wasi_app`);
  pgm.dropTable('template_media_cache');
};
