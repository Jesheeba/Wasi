// Automation rules with trigger "*" (match any message) fire at most once per
// chat per 24 hours (build-docs/features/automation-rule-view-edit.md, audit
// item B). This column is that throttle: automationEngine claims it with a
// single conditional UPDATE before sending, so two inbound messages arriving
// together can't both send the catch-all reply.
//
// Nullable, no default, no backfill: null means "never auto-replied", which
// is the correct starting state for every existing chat.
//
// DEPLOY ORDER: apply BEFORE the automationEngine code that reads it. Without
// the column the claim UPDATE throws, and the engine reports that "*" rule as
// failed (handled, nothing sent) instead of replying.
//
// `chats` has a table-level wasi_app grant (migration 013), so no grant needed.
exports.up = (pgm) => {
  pgm.addColumns('chats', {
    auto_reply_at: { type: 'timestamptz' },
  });
};

// Only a throttle timestamp; dropping it at worst lets one extra catch-all
// reply go out per chat. No live-row guard needed.
exports.down = (pgm) => {
  pgm.dropColumns('chats', ['auto_reply_at']);
};
