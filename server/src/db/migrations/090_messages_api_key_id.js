// Attribution for an outbound message sent through the Hub API
// (routes/apiV1Messages.js) - which of the client's own API keys made the
// call. Prompted directly: an admin investigation (2026-11-11) into a
// 10:24 IST send to Sirah Digital could only identify the calling app
// ("Auratel") by correlating messages.sent_at against api_keys.last_used_at
// to the millisecond - a one-off forensic trick, not something either the
// client dashboard or the admin panel could show, because messages never
// recorded which key sent it at all.
//
// Nullable, no default: every non-Hub-API send (chats.js's inbox reply,
// flowEngine, broadcastRunner, automationEngine, clientNotifier) leaves it
// null - that's the correct "not sent via a Hub API key" value, not a gap to
// backfill. Existing rows stay null; there is nothing to derive them from.
//
// on delete set null (not cascade): deleting an API key must not delete the
// message history it once sent - same reasoning api_keys' own soft-delete
// convention already establishes (revoke/soft-delete, never a real row
// delete, specifically so history survives).
//
// `messages` has a table-level wasi_app grant (confirmed live, 2026-11-11:
// SELECT/INSERT/UPDATE/DELETE all present for wasi_app with no column-level
// restriction), so this column needs no grant migration of its own - unlike
// the column-level grants on clients/wabas (migrations 043, 069).
exports.up = (pgm) => {
  pgm.addColumns('messages', {
    api_key_id: { type: 'uuid', references: 'api_keys', onDelete: 'SET NULL' },
  });
  pgm.createIndex('messages', 'api_key_id', { where: 'api_key_id is not null' });
};

exports.down = (pgm) => {
  pgm.dropColumns('messages', ['api_key_id']);
};
