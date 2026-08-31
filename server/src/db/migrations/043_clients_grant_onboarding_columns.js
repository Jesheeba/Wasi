// Fixes a real, standing gap found while validating the unmerged
// origin/gap-fixes-a-e branch's CI-pipeline proposal against a genuinely
// fresh database (2026-08-28) — see CLAUDE.md Known Gaps for the full
// writeup. Migration 013_tenant_isolation.js granted wasi_app (the
// restricted role every tenant-scoped route runs as via req.db) SELECT on
// only clients' original column set: (id, name, email, status,
// tenant_slug, email_verified, created_at). Migration
// 035_client_onboarding_fields.js later added 8 real columns
// (contact_person_name, contact_phone, company_details, developer_name,
// developer_phone, developer_email, integration_requirements,
// additional_notes) without a corresponding grant extension.
//
// This is not theoretical: clientsRepo.findById is called with req.db (not
// the privileged pool) from real client-authenticated routes —
// routes/auth.js's GET /me-equivalent and routes/onboarding.js's status
// check both select the client's full row, onboarding columns included.
// On a database built purely from replaying every migration in order (a
// genuinely fresh environment, disaster recovery, or CI), those queries
// fail with "permission denied for table clients" — invisible today only
// because the real shared Supabase instance already permits it somehow
// (a manual GRANT run directly against it at some point, never captured
// back into a migration, or a pre-existing role/permission difference).
//
// UPDATE and DELETE need no equivalent fix: migration 013's grant for
// those is table-level, not column-scoped (`grant ..., update, delete on
// clients to wasi_app`), and an unscoped table-level privilege in Postgres
// automatically covers any column added later — only column-level SELECT
// grants need updating explicitly when a new column is added. That's
// exactly why this gap only ever affected SELECT.
//
// Column-level GRANT SELECT statements are additive, not replacing — this
// adds to migration 013's original 6-column grant, it doesn't need to
// restate it.
exports.up = (pgm) => {
  pgm.sql(`
    grant select (
      contact_person_name, contact_phone, company_details,
      developer_name, developer_phone, developer_email,
      integration_requirements, additional_notes
    )
    on clients to wasi_app
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    revoke select (
      contact_person_name, contact_phone, company_details,
      developer_name, developer_phone, developer_email,
      integration_requirements, additional_notes
    )
    on clients from wasi_app
  `);
};
