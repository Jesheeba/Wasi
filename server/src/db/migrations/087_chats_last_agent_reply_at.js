// AI agent prerequisite (docs/ai-agent/SPEC.md section 7 gate 4,
// IMPLEMENTATION.md unit 0.2): when did a HUMAN last reply to this chat?
//
// This is the signal that stops the agent talking over the client's staff.
// It is deliberately narrow, because the first draft of the spec got this
// wrong (it would have counted every flow/broadcast/API send as "a human is
// active" and silenced the agent for 15 minutes after every automated
// message). It is written from EXACTLY two places and nowhere else:
//
//   1. routes/chats.js: a person replying from the Wasi inbox (send + retry).
//   2. chatsRepo.insertEcho: a person replying from the WhatsApp Business app
//      on their own phone (Coexistence), and only when the echo row is new
//      (an echo of a message Wasi itself already sent hits the unique
//      meta_message_id and inserts nothing, so it never counts).
//
// It must never be written by flowEngine, automationEngine, broadcastRunner,
// the Hub API, template sends or the agent itself, which is why it is NOT in
// insertOutboundPending or messagingService: those are the choke points all
// of those share. test/chatsLastAgentReplyAt.test.js scans the source tree to
// keep it that way.
//
// Nullable, no default, and NOT backfilled: history cannot tell a human send
// from a flow/broadcast/API send (messages has no sender column; `source`
// only separates 'api' from 'whatsapp_app'), so any backfill would be a
// guess, and a wrong guess silences the agent on every existing chat. Null
// means "unknown", and gate 4 reads it as "no recent human reply", never as a
// timestamp (see services/humanActivity.js). NOTE the polarity differs from
// chats.last_inbound_at, where null means window CLOSED.
//
// `chats` has a table-level wasi_app grant, so no extra grant is needed.
// Deploy order: apply this before the code that writes it, or the human
// send route's write (guarded, non-fatal) and insertEcho's UPDATE would fail.
exports.up = (pgm) => {
  pgm.addColumns('chats', {
    last_agent_reply_at: { type: 'timestamptz' },
  });
};

// Unlike last_inbound_at, this value is NOT derivable from anything else, so
// a rollback destroys real data. Same live-row guard discipline as
// migrations 032/036/039/040/056/080.
exports.down = async (pgm) => {
  const [{ count }] = await pgm.db.select(
    'select count(*)::int as count from chats where last_agent_reply_at is not null'
  );
  if (count > 0) {
    throw new Error(
      `Cannot roll back 087_chats_last_agent_reply_at: ${count} chat(s) have a recorded human ` +
      `reply time that cannot be rebuilt from messages. Rolling back would silently erase it.`
    );
  }
  pgm.dropColumns('chats', ['last_agent_reply_at']);
};
