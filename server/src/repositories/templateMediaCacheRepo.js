// The default/fallback row only — is_default (migration 030) is what makes
// this safe now that a template can have other, non-default asset rows too.
async function findByTemplateId(db, clientId, templateId) {
  const { rows } = await db.query(
    'select * from template_media_cache where client_id = $1 and template_id = $2 and is_default',
    [clientId, templateId]
  );
  return rows[0] || null;
}

// One default row per template — a second resolve (initial seed already
// existed, or the default's refresh cycle ran) updates the existing row
// rather than inserting a duplicate, relying on the migration's partial
// unique index (template_id where is_default).
//
// Real, previously-undiscovered bug, found and fixed while building the
// "no default, but assets exist" message above: this used to say
// `on conflict (template_media_cache_one_default_per_template)`, naming
// the partial unique index migration 030 created — but ON CONFLICT's
// parenthesized form means "these are the conflicting COLUMNS", not "this
// is the constraint/index name" (that form is `ON CONFLICT ON CONSTRAINT
// name`, and only works for a real named constraint, not a plain
// CREATE INDEX). Postgres rejected it outright: "column
// template_media_cache_one_default_per_template does not exist" —
// confirmed live against the real database, not a hypothetical. This
// function is called both by POST /'s creation-time seed (AFTER Meta's
// template was already created and the local row already inserted) and by
// resolveMediaId's 30-day refresh cycle, uncaught by either caller — so
// every single call has always thrown a raw request-ending error instead
// of ever writing the default row, since the day migration 030 shipped.
// This is the real, most likely explanation for how a media-header
// template could exist, fully approved, with real uploaded assets, and
// still have no default row at all — not a template genuinely "synced in
// from Meta" as first suspected. The correct partial-index conflict
// target names the column(s) and repeats the index's own WHERE predicate.
async function upsert(db, clientId, templateId, { mediaId, filename }) {
  const { rows } = await db.query(
    `insert into template_media_cache (client_id, template_id, media_id, filename, resolved_at, is_default)
     values ($1, $2, $3, $4, now(), true)
     on conflict (template_id) where is_default do update
       set media_id = excluded.media_id, filename = excluded.filename, resolved_at = now()
     returning *`,
    [clientId, templateId, mediaId, filename || null]
  );
  return rows[0];
}

// A specific asset a send was pointed at, not necessarily the default —
// scoped by client_id so one tenant can never resolve another's asset id.
async function findAssetById(db, clientId, assetId) {
  const { rows } = await db.query(
    'select * from template_media_cache where client_id = $1 and id = $2',
    [clientId, assetId]
  );
  return rows[0] || null;
}

// Every media row for a template, default first — used by (a)
// mediaHeaderService.resolveMediaId to build an accurate "no default set,
// but N assets exist" message instead of implying nothing was ever
// uploaded, and (b) the New Campaign modal's existing-asset picker
// (GET /api/templates/:id/header-media).
async function listByTemplateId(db, clientId, templateId) {
  const { rows } = await db.query(
    'select * from template_media_cache where client_id = $1 and template_id = $2 order by is_default desc, created_at desc',
    [clientId, templateId]
  );
  return rows;
}

// Flips exactly one row to is_default=true for this template and demotes
// any prior default — two sequential UPDATEs, not one multi-row UPDATE, so
// the partial unique index (template_media_cache_one_default_per_template)
// is never briefly violated mid-statement (a single UPDATE touching both
// the old and new default rows has no guaranteed per-row ordering, so the
// new row's is_default=true could be written while the old row's is still
// true). No BEGIN/COMMIT of its own — `db` here is req.db, already inside
// the whole request's own transaction (tenantContext.js), which commits or
// rolls back everything together when the response is sent; a nested
// BEGIN/ROLLBACK here would abort that outer transaction instead of just
// this action. Existence is checked BEFORE demoting anything, so a bad
// assetId is a no-op (returns null) rather than leaving the template with
// no default row at all.
async function setDefault(db, clientId, templateId, assetId) {
  const { rows: existing } = await db.query(
    'select 1 from template_media_cache where client_id = $1 and id = $2 and template_id = $3',
    [clientId, assetId, templateId]
  );
  if (existing.length === 0) return null;

  await db.query(
    'update template_media_cache set is_default = false where client_id = $1 and template_id = $2 and is_default',
    [clientId, templateId]
  );
  const { rows } = await db.query(
    'update template_media_cache set is_default = true where client_id = $1 and id = $2 returning *',
    [clientId, assetId]
  );
  return rows[0];
}

// A new non-default asset — one row per upload, never collapsed into an
// existing one, since a template can now hold many send-time alternatives to
// its approval sample (see migration 030's comment).
async function insertAsset(db, clientId, templateId, { mediaId, filename }) {
  const { rows } = await db.query(
    `insert into template_media_cache (client_id, template_id, media_id, filename, resolved_at, is_default)
     values ($1, $2, $3, $4, now(), false)
     returning *`,
    [clientId, templateId, mediaId, filename || null]
  );
  return rows[0];
}

// Refreshing a non-default asset in place (its 30-day media id expired) —
// same row, not a new one, so anything already pointing at this asset id
// (a broadcast, a flow node's config) keeps working.
async function updateAsset(db, clientId, assetId, { mediaId, filename }) {
  const { rows } = await db.query(
    `update template_media_cache
       set media_id = $3, filename = $4, resolved_at = now()
     where client_id = $1 and id = $2
     returning *`,
    [clientId, assetId, mediaId, filename || null]
  );
  return rows[0];
}

module.exports = { findByTemplateId, upsert, findAssetById, insertAsset, updateAsset, listByTemplateId, setDefault };
