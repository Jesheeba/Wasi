// Dormant-client visibility (a client with 1,342 unanswered messages went
// 20 days unnoticed — there was no login tracking on `clients` at all to
// have ever flagged it). team_members already got last_login_at in
// migration 056_team_member_auth.js, set on every successful team login by
// teamMembersRepo.touchLastLogin; this is the equivalent for the owner
// login identity, which had no such column.
//
// Nullable, no backfill — "never logged in since this column existed" must
// stay honestly distinguishable from a real recorded login, same discipline
// as every other monitoring column this codebase has added (messaging_tier/
// messaging_tier_checked_at, delivered_at/read_at/failed_at, the whole
// wabas sendability set).
//
// The SELECT grant is added in THIS SAME migration, not a follow-up one —
// this exact class of bug (a wasi_app column-scoped SELECT grant on
// `clients` never extended to cover a newly added column) has already
// happened twice (migrations 043 and 069, both follow-up fixes after a real
// "permission denied for table clients" was found live). clientsRepo.js's
// SAFE_COLUMNS now includes last_login_at, and routes/auth.js's GET /me and
// routes/onboarding.js's own-profile read both go through req.db (the
// restricted wasi_app role) — so this column needs the grant from the
// start, not discovered the third time via a live failure.
exports.up = (pgm) => {
  pgm.addColumn('clients', {
    last_login_at: { type: 'timestamptz' },
  });
  pgm.sql(`grant select (last_login_at) on clients to wasi_app`);
};

exports.down = (pgm) => {
  pgm.sql(`revoke select (last_login_at) on clients from wasi_app`);
  pgm.dropColumn('clients', 'last_login_at');
};
