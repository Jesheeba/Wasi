// GAP_FIX_PLAN.md Phase E2 — team inbox, attribution-only scope (asked the
// user rather than guessing: full per-agent login was the other option,
// ~3x the effort and a bigger, less reversible change to the auth system —
// they chose assignment labels under the current single shared client
// login). A chat can be assigned to one team_members row; ON DELETE SET
// NULL so removing a team member un-assigns their chats instead of
// failing or cascading chat deletion.
exports.up = (pgm) => {
  pgm.addColumn('chats', {
    assigned_to: { type: 'uuid', references: 'team_members', onDelete: 'SET NULL' },
  });
  pgm.createIndex('chats', 'assigned_to');
};

exports.down = (pgm) => {
  pgm.dropColumn('chats', 'assigned_to');
};
