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
async function upsert(db, clientId, templateId, { mediaId, filename }) {
  const { rows } = await db.query(
    `insert into template_media_cache (client_id, template_id, media_id, filename, resolved_at, is_default)
     values ($1, $2, $3, $4, now(), true)
     on conflict (template_media_cache_one_default_per_template) do update
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

module.exports = { findByTemplateId, upsert, findAssetById, insertAsset, updateAsset };
