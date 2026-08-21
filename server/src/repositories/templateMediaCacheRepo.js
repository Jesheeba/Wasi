async function findByTemplateId(db, clientId, templateId) {
  const { rows } = await db.query(
    'select * from template_media_cache where client_id = $1 and template_id = $2',
    [clientId, templateId]
  );
  return rows[0] || null;
}

// One row per template — a second resolve (initial seed already existed, or
// a refresh cycle ran) updates the existing row rather than inserting a
// duplicate, relying on the migration's unique(template_id).
async function upsert(db, clientId, templateId, { mediaId, filename }) {
  const { rows } = await db.query(
    `insert into template_media_cache (client_id, template_id, media_id, filename, resolved_at)
     values ($1, $2, $3, $4, now())
     on conflict (template_id) do update
       set media_id = excluded.media_id, filename = excluded.filename, resolved_at = now()
     returning *`,
    [clientId, templateId, mediaId, filename || null]
  );
  return rows[0];
}

module.exports = { findByTemplateId, upsert };
