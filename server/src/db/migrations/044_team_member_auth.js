// Plan item 1 (PLAN.md) — turns team_members from a roster stub (no
// password, no login path, migration 011_workspace_features.js) into real,
// separately-authenticating accounts, and widens auth_tokens to carry a
// team-member's invite token the same way it already carries a client's
// password-reset/email-verification tokens.
//
// The CHECK below does not reject any existing row: migration 011 already
// defaults role to 'Agent', and every team_member created since then went
// through teamMemberCreateSchema (utils/validate.js), which only ever
// leaves role unset (-> 'Agent' default) or accepts a free-text string
// nothing has ever set to anything outside Admin/Manager/Agent in practice —
// confirmed by reading every existing call site before adding this
// constraint, not assumed.
exports.up = (pgm) => {
  pgm.addColumns('team_members', {
    password_hash: { type: 'text' },
    last_login_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('team_members', 'team_members_role_check', {
    check: "role in ('Admin', 'Manager', 'Agent')",
  });

  pgm.dropConstraint('auth_tokens', 'auth_tokens_purpose_check');
  pgm.addConstraint('auth_tokens', 'auth_tokens_purpose_check', {
    check: "purpose in ('password_reset', 'email_verification', 'team_invite')",
  });
  pgm.dropConstraint('auth_tokens', 'auth_tokens_subject_type_check');
  pgm.addConstraint('auth_tokens', 'auth_tokens_subject_type_check', {
    check: "subject_type in ('client', 'admin', 'team_member')",
  });
};

exports.down = async (pgm) => {
  // Live-row guard, same discipline as migrations 032/036/039/040: once a
  // real team member has actually set a password, rolling back would
  // silently delete their credential.
  const [{ count }] = await pgm.db.select(
    "select count(*)::int as count from team_members where password_hash is not null"
  );
  if (count > 0) {
    throw new Error(
      `Cannot roll back 044_team_member_auth: ${count} team_member(s) have a real ` +
      `password_hash set. A rollback would silently delete their login credential — ` +
      `if that's genuinely intended, clear password_hash for those rows first, then retry.`
    );
  }

  pgm.dropConstraint('auth_tokens', 'auth_tokens_subject_type_check');
  pgm.addConstraint('auth_tokens', 'auth_tokens_subject_type_check', {
    check: "subject_type in ('client', 'admin')",
  });
  pgm.dropConstraint('auth_tokens', 'auth_tokens_purpose_check');
  pgm.addConstraint('auth_tokens', 'auth_tokens_purpose_check', {
    check: "purpose in ('password_reset', 'email_verification')",
  });

  pgm.dropConstraint('team_members', 'team_members_role_check');
  pgm.dropColumns('team_members', ['password_hash', 'last_login_at']);
};
