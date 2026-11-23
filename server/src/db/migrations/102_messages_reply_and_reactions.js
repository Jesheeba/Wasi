// Reply/quote and emoji reactions (WhatsApp-parity features, 2026-11-23) -
// both genuinely supported by Meta's Cloud API (context.message_id on a
// send, and the type:'reaction' message shape), unlike edit/delete/star,
// which the Business Platform does not expose.
//
// reply_to_message_id is nullable and self-referencing: an outbound reply
// sets it when the agent clicks Reply in the UI (messagingService resolves
// the target's own meta_message_id and sends it as Meta's context field);
// an inbound reply sets it when metaWebhook.js resolves an inbound
// message's context.id (the wamid being replied to) back to a local row.
// ON DELETE SET NULL, not CASCADE: this app never deletes messages, but if
// that ever changes, losing the quoted-reply link on an unrelated row is
// the right failure mode, not cascading a delete through it.
//
// customer_reaction_emoji / agent_reaction_emoji are two separate nullable
// columns, not one - WhatsApp's reaction model is "each party has at most
// one active reaction per message, replacing their own prior one", not a
// shared/multi-reaction stack, and Meta's inbound reaction webhook event
// carries no indication of a shared state, only the fact that THIS party
// (the customer's side - an inbound event - or this app's own outbound
// send, meaning the agent) reacted. An empty string means "no reaction",
// matching Meta's own documented remove-reaction convention (an empty
// emoji value), so these are left unconstrained text rather than a CHECK
// against a fixed emoji set.
exports.up = (pgm) => {
  pgm.addColumns('messages', {
    reply_to_message_id: { type: 'uuid', references: 'messages', onDelete: 'SET NULL' },
    customer_reaction_emoji: { type: 'text' },
    agent_reaction_emoji: { type: 'text' },
  });
  pgm.createIndex('messages', 'reply_to_message_id');
  // `messages` already has a table-level wasi_app grant (migration 013) -
  // confirmed, not assumed, before writing this comment - so these new
  // columns need no separate grant extension (unlike clients/wabas, whose
  // SELECT grants are column-level - see CLAUDE.md's Known Gaps for why
  // that distinction matters and has bitten this project twice before).
};

exports.down = (pgm) => {
  pgm.dropColumns('messages', ['reply_to_message_id', 'customer_reaction_emoji', 'agent_reaction_emoji']);
};
