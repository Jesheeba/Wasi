// Password reset item 3 (session invalidation). Adds a token version /
// session epoch to every identity table that issues its own JWT
// (utils/auth.js's signClientToken/signAdminToken/signTeamMemberToken) —
// clients, admin_users, and team_members do NOT share a table (checked
// before writing this: 3 separate tables, each with its own password_hash
// and its own sign*Token function), so this touches all 3.
//
// Default 0, NOT NULL, matching every existing row. A JWT issued before this
// deploy has no `tokenVersion` claim at all — the auth middleware treats a
// missing claim as 0, which equals every existing row's default, so
// EXISTING TOKENS SURVIVE THIS DEPLOY. They start getting invalidated only
// from the next real bump (a password change/reset from that point on), not
// as a side effect of this migration shipping. Decided deliberately, not
// defaulted into — see CLAUDE.md/the task write-up for the alternative
// (bump every row's version to 1 here, forcing a global re-login) that was
// NOT taken.
exports.up = (pgm) => {
  pgm.addColumns('clients', {
    token_version: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addColumns('admin_users', {
    token_version: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addColumns('team_members', {
    token_version: { type: 'integer', notNull: true, default: 0 },
  });

  // wasi_app's column-specific SELECT grant on clients (migration 013, since
  // extended by 043/069) is NOT extended here on purpose — token_version is
  // read only by the auth middleware, which queries clients directly via the
  // privileged `pool` (before req.db / tenant context exist, same reasoning
  // as clientsRepo.findByEmail), never via req.db. Ungranted is correct here,
  // not an oversight — see CLAUDE.md's own repeated warning about this
  // exact class of gap before assuming this needs the same treatment.
};

exports.down = (pgm) => {
  pgm.dropColumns('team_members', ['token_version']);
  pgm.dropColumns('admin_users', ['token_version']);
  pgm.dropColumns('clients', ['token_version']);
};
