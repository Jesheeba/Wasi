// Meta Official Template Library cache (wasi-master-plan.md §2b, migration
// 042). Global reference content, not tenant data — same shape as
// template_library, no client_id, no RLS.

// listCached defaults to zero-variable entries only — Phase 0 decision:
// v1 only surfaces library templates with no {{n}} placeholders, sidestepping
// Wasi's named-params-only pipeline entirely (see migration 042's comment).
// `includeParameterized` exists only for the admin status view (so an admin
// can see the FULL cached catalog size, not just what v1 exposes to
// clients) — routes/templateLibrary.js's client-facing GET /meta never
// passes it.
async function listCached(db, { includeParameterized = false } = {}) {
  const { rows } = await db.query(
    includeParameterized
      ? `select * from meta_template_library_cache order by name asc`
      : `select * from meta_template_library_cache where jsonb_array_length(body_params) = 0 order by name asc`
  );
  return rows;
}

async function findById(db, id) {
  const { rows } = await db.query(`select * from meta_template_library_cache where id = $1`, [id]);
  return rows[0] || null;
}

// Upserts by meta_library_id (Meta's own real identity for a catalog
// entry, not this table's uuid pk) — a re-refresh updates existing rows in
// place rather than delete-then-reinsert, same "never orphan a foreign key
// across a re-seed" reasoning as seedTemplateLibrary.js's own convention
// (this table has no child rows yet, but the discipline is worth keeping
// consistent for whenever it does).
async function upsertBatch(db, entries) {
  let count = 0;
  for (const entry of entries) {
    await db.query(
      `insert into meta_template_library_cache (
         meta_library_id, name, category, language, topic, usecase, industry,
         header_text, body, footer_text, buttons_json, body_params, updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       on conflict (meta_library_id) do update set
         name = excluded.name, category = excluded.category, language = excluded.language,
         topic = excluded.topic, usecase = excluded.usecase, industry = excluded.industry,
         header_text = excluded.header_text, body = excluded.body, footer_text = excluded.footer_text,
         buttons_json = excluded.buttons_json, body_params = excluded.body_params, updated_at = now()`,
      [
        entry.meta_library_id, entry.name, entry.category, entry.language,
        entry.topic || null, entry.usecase || null,
        entry.industry ? JSON.stringify(entry.industry) : null,
        entry.header_text || null, entry.body, entry.footer_text || null,
        entry.buttons_json ? JSON.stringify(entry.buttons_json) : null,
        JSON.stringify(entry.body_params || []),
      ]
    );
    count++;
  }
  return count;
}

// Independent Auditor/QA finding: upsertBatch alone only ever adds/updates —
// nothing removed a row whose meta_library_id no longer appears in a fresh
// refresh, so a template Meta withdrew from its catalog stayed cached (and
// client-offerable) forever. Called right after upsertBatch in
// refreshNow() with the exact set of ids the latest fetch actually
// returned; a row not in that set is gone from Meta's own catalog, so it's
// removed here too — this table is a pure cache (its own down() comment:
// "100% reproducible from a real Meta refresh call"), so deleting a stale
// row loses nothing that matters.
async function pruneMissing(db, currentMetaLibraryIds) {
  if (!currentMetaLibraryIds.length) {
    // An empty catalog response almost certainly means something went
    // wrong upstream (a transient Meta error returning no data), not that
    // Meta genuinely has zero library templates — refuse to wipe the whole
    // cache on that ambiguous signal. A real "nothing to prune" case is
    // handled fine by the WHERE NOT IN clause below when the array isn't empty.
    return 0;
  }
  const { rowCount } = await db.query(
    `delete from meta_template_library_cache where meta_library_id != all($1::text[])`,
    [currentMetaLibraryIds]
  );
  return rowCount;
}

async function getRefreshMeta(db) {
  const { rows } = await db.query(`select * from meta_template_library_refresh_meta where id = true`);
  return rows[0] || null;
}

async function recordRefreshSuccess(db, entryCount) {
  await db.query(
    `update meta_template_library_refresh_meta
     set last_refreshed_at = now(), last_refresh_entry_count = $1, last_refresh_error = null
     where id = true`,
    [entryCount]
  );
}

async function recordRefreshFailure(db, errorMessage) {
  await db.query(
    `update meta_template_library_refresh_meta set last_refresh_error = $1 where id = true`,
    [errorMessage]
  );
}

module.exports = { listCached, findById, upsertBatch, pruneMissing, getRefreshMeta, recordRefreshSuccess, recordRefreshFailure };
