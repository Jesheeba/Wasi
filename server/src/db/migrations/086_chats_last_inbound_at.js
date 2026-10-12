// AI agent prerequisite (docs/ai-agent/SPEC.md section 6, IMPLEMENTATION.md
// unit 0.1): when did the CUSTOMER last write in this chat? Meta's 24-hour
// customer service window runs from that moment, so it is the only value
// that can say whether a free-form reply is still sendable.
//
// chats.last_message_at (migration 003) is NOT a substitute: it is bumped on
// every inbound, every outbound send and every Coexistence echo, so using it
// would reopen the window each time staff or a flow replied.
//
// Written by chatsRepo.insertInbound only (the one code path that inserts a
// direction = 'in' message), from the message's own sent_at, never now().
// Nullable with no default: null means "unknown", and a reader must treat
// that as window closed, not open. Existing rows are populated by the
// separate, re-runnable server/scripts/backfill-last-inbound-at.js, not by
// this migration, so a slow backfill can never hold this DDL open.
//
// DEPLOY ORDER MATTERS: insertInbound's UPDATE references this column, and
// that UPDATE runs after the message INSERT. If the new code reached a
// database without this column, the UPDATE would throw after the insert had
// committed, Meta would retry, and the retry's idempotent insert would be a
// no-op that skips the rest of the webhook handler for that message. Apply
// this migration BEFORE the code that writes it (deploy.sh already runs the
// migration gate before `docker compose up -d`).
//
// `chats` has a table-level wasi_app grant (see migration 013), so a new
// column needs no grant of its own; unlike the column-level grants on
// clients/wabas (migrations 043, 069) nothing extra is required here.
exports.up = (pgm) => {
  pgm.addColumns('chats', {
    last_inbound_at: { type: 'timestamptz' },
  });
};

// The value is fully derivable from messages (max(sent_at) per chat where
// direction = 'in'), so dropping it loses nothing that cannot be rebuilt by
// re-running the backfill script. No live-row guard is needed.
exports.down = (pgm) => {
  pgm.dropColumns('chats', ['last_inbound_at']);
};
