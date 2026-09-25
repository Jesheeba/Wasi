// Coexistence echo ingestion, Phase 1 — a `messages` row can now originate
// from two structurally different places: this app's own send pipeline
// (chat send, broadcast, flow engine, Hub API — all of which already write
// via insertOutboundPending) or a business's own phone via the WhatsApp
// Business app, arriving as a smb_message_echoes webhook event
// (chatsRepo.insertEcho). Nothing before this could tell the two apart —
// this column is purely additive so the chat UI can visually distinguish
// them (see app.js's chat bubble rendering).
//
// Deliberately not backfilled and not applied retroactively to existing
// rows — by direct instruction, this phase only covers echoes from the
// moment smb_message_echoes is actually turned on in the App Dashboard
// (which hasn't happened yet — see this migration's own module comment in
// metaWebhook.js). Every existing row keeps reading as 'api', which is
// correct: every message in this table today really was sent through this
// app's own pipeline, since echo ingestion didn't exist yet to write
// anything else.
exports.up = (pgm) => {
  pgm.addColumns('messages', {
    source: { type: 'text', notNull: true, default: 'api' },
  });
  pgm.addConstraint('messages', 'messages_source_check', {
    check: "source in ('api', 'whatsapp_app')",
  });
};

exports.down = async (pgm) => {
  // Live-row guard, same discipline as migrations 032/036/039/040/056: once
  // a real echo has been ingested, rolling back would silently destroy the
  // one signal that distinguishes it from a message this app actually sent.
  const [{ count }] = await pgm.db.select(
    "select count(*)::int as count from messages where source = 'whatsapp_app'"
  );
  if (count > 0) {
    throw new Error(
      `Cannot roll back 080_messages_source: ${count} message(s) are recorded as real ` +
      `'whatsapp_app' echoes. Rolling back would silently erase the only signal that ` +
      `distinguishes them from a message this app sent itself.`
    );
  }
  pgm.dropConstraint('messages', 'messages_source_check');
  pgm.dropColumns('messages', ['source']);
};
