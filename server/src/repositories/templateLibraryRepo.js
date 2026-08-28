// WhatsApp Template Message Library (wasi-master-plan.md §2). Read-only to
// clients — no create/update here, content is seeded by
// server/src/db/seedTemplateLibrary.js only (§2.6: no admin CMS in v1).

// Explicit column allowlist, not `select *` — same defense-in-depth
// discipline migration 013_tenant_isolation.js's comment establishes for
// clients/wabas: nothing here is secret today, but a future column added
// to this table (e.g. an internal admin note field) shouldn't become
// client-visible just by existing. created_by_admin_id is deliberately
// excluded — an opaque FK to admin_users with no product purpose for a
// client to see.
const LIBRARY_COLUMNS = `
  id, industry, use_case, category, title, header_type, header_content,
  body, footer, buttons_json, sample_values_json, auth_options, language,
  is_active, created_at, updated_at
`;

// industry/category/useCase are optional filters — null means "no filter
// on this dimension". is_active = true is always enforced: an
// admin-deactivated entry (soft-hide, no delete path needed since nothing
// ever references a library row except usage history, which survives via
// ON DELETE CASCADE regardless of is_active) must stop appearing to
// clients immediately without breaking any already-recorded usage log.
async function listActive(db, { industry, category, useCase } = {}) {
  const { rows } = await db.query(
    `select ${LIBRARY_COLUMNS}
     from template_library
     where is_active = true
       and ($1::text is null or industry = $1)
       and ($2::text is null or category = $2)
       and ($3::text is null or use_case = $3)
     order by industry, use_case, title`,
    [industry || null, category || null, useCase || null]
  );
  return rows;
}

// Not tenant-scoped (template_library has no client_id — it's global
// content, see migration 036's comment) — any authenticated client may
// look up any active entry by id. Deliberately excludes is_active=false
// rows from a direct id lookup too, same as listActive, so a deactivated
// entry can't be reached via a stale bookmarked/cached id either.
async function findActiveById(db, id) {
  const { rows } = await db.query(
    `select ${LIBRARY_COLUMNS} from template_library where id = $1 and is_active = true`,
    [id]
  );
  return rows[0] || null;
}

// Usage logging (routes/templateLibrary.js's POST /:id/use) — see that
// route's comment for why it's awaited-and-caught locally rather than a
// true fire-and-forget call.
async function recordUsage(db, { libraryTemplateId, clientId }) {
  await db.query(
    'insert into template_library_usage (library_template_id, client_id) values ($1, $2)',
    [libraryTemplateId, clientId]
  );
}

module.exports = { listActive, findActiveById, recordUsage };
