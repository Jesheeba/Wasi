// Bug found live while creating the first flow-starting rule (migration
// 023 added automation_rules_action_xor_flow expecting action to be
// nullable when flow_id is set, but never actually dropped the original
// `action text notNull` from 003_tenant_tables.js) — the CHECK constraint
// was unreachable in its flow_id branch; every insert with flow_id set and
// action null failed the NOT NULL constraint before the CHECK was ever
// evaluated. 023 is already applied/deployed, so this is a follow-up fix,
// not an edit to it — same reasoning migration 016 fixed a too-narrow
// CHECK with a new migration rather than rewriting the original.
exports.up = (pgm) => {
  pgm.alterColumn('automation_rules', 'action', { notNull: false });
};

exports.down = (pgm) => {
  pgm.alterColumn('automation_rules', 'action', { notNull: true });
};
