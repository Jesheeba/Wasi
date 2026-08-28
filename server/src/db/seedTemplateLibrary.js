// Seeds the WhatsApp Template Message Library (wasi-master-plan.md §2.6:
// "no full admin CMS for editing content in v1 — seed via migration/script
// first"). Idempotent — safe to re-run any time content in
// templateLibraryContent.js changes: upserts by the (industry, use_case)
// natural key (migration 037), so a re-run updates existing rows' content
// in place rather than duplicating or orphaning any real client's already-
// recorded template_library_usage row for that same conceptual template.
//
// Aborts entirely (no partial insert) if ANY entry fails
// validateLibraryContent — this is the actual enforcement of "every
// template manually checked against Meta's rejection reasons" before it
// ever reaches a client's browse view, not a comment promising it was
// checked once by hand.
require('dotenv').config();
const { pool } = require('./pool');
const adminUsersRepo = require('../repositories/adminUsersRepo');
const { TEMPLATE_LIBRARY_CONTENT } = require('./templateLibraryContent');
const { validateLibraryContent } = require('../utils/templateLibraryValidation');

const DEMO_ADMIN_EMAIL = process.env.DEV_ADMIN_EMAIL || 'admin@wasi.local';

async function seedTemplateLibrary() {
  const errors = validateLibraryContent(TEMPLATE_LIBRARY_CONTENT);
  if (errors.length > 0) {
    console.error(`Aborting: ${errors.length} template_library content entries failed validation:`);
    errors.forEach((e) => console.error(' -', e));
    process.exitCode = 1;
    return;
  }
  console.log(`Validated ${TEMPLATE_LIBRARY_CONTENT.length} template_library entries — 0 errors.`);

  // Best-effort attribution only — created_by_admin_id is nullable
  // (ON DELETE SET NULL) specifically so a missing/renamed demo admin never
  // blocks seeding real content.
  const demoAdmin = await adminUsersRepo.findByEmail(DEMO_ADMIN_EMAIL).catch(() => null);
  const createdByAdminId = demoAdmin ? demoAdmin.id : null;

  const client = await pool.connect();
  client.on('error', (err) => console.error('seedTemplateLibrary: checked-out client error:', err.message));
  try {
    await client.query('BEGIN');
    for (const entry of TEMPLATE_LIBRARY_CONTENT) {
      await client.query(
        `insert into template_library (
           industry, use_case, category, title, header_type, header_content,
           body, footer, buttons_json, sample_values_json, auth_options, language,
           is_active, created_by_admin_id
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13)
         on conflict (industry, use_case) do update set
           category = excluded.category,
           title = excluded.title,
           header_type = excluded.header_type,
           header_content = excluded.header_content,
           body = excluded.body,
           footer = excluded.footer,
           buttons_json = excluded.buttons_json,
           sample_values_json = excluded.sample_values_json,
           auth_options = excluded.auth_options,
           language = excluded.language,
           is_active = true,
           updated_at = now()`,
        [
          entry.industry,
          entry.use_case,
          entry.category,
          entry.title,
          entry.header?.type || null,
          entry.header?.text || null,
          entry.body,
          entry.footer || null,
          entry.buttons ? JSON.stringify(entry.buttons) : null,
          JSON.stringify(entry.sample_values || {}),
          entry.auth_options ? JSON.stringify(entry.auth_options) : null,
          'en_US',
          createdByAdminId,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(`Seeded ${TEMPLATE_LIBRARY_CONTENT.length} template_library entries (industries: ${
    [...new Set(TEMPLATE_LIBRARY_CONTENT.map((e) => e.industry))].join(', ')
  }).`);
}

if (require.main === module) {
  seedTemplateLibrary()
    .then(() => pool.end())
    .catch((err) => {
      console.error('seedTemplateLibrary failed:', err);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { seedTemplateLibrary };
