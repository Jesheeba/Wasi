// Consent hardening Phase 1 (queryable-actor half). consent_events already
// records WHAT changed and its evidence, but never WHO did it beyond the
// free-text `source` string — not enough to answer "who confirmed this bulk
// opt-in and when" for a compliance question. Three nullable columns, purely
// additive, no backfill (every existing row predates this and genuinely has
// no captured actor):
//   actor_type: 'owner' | 'team_member' | 'flow' | 'inbound_contact' | null
//     — same vocabulary requireClientOrTeamAuth already uses for
//     req.actorType ('owner'/'team_member'); 'flow' for an automation-flow
//     set_opt_in node (source is already 'flow', this makes it queryable
//     without parsing evidence); 'inbound_contact' reserved for Phase 4's
//     START-keyword self-service opt-in. NULL for the pre-existing inbound
//     STOP-keyword writes (source: 'inbound_stop_keyword') — that's a Meta
//     webhook event, not a human/flow actor, and forcing a value there would
//     be inventing data this app doesn't have.
//   actor_id: the team_members.id when actor_type = 'team_member'; NULL for
//     'owner' (the client_id column already identifies the account) and
//     every other actor_type. Deliberately NOT a foreign key — a team
//     member can be removed later and this row must stay a readable
//     historical record, not get cascade-deleted or dangle a broken FK.
//   batch_id: groups every consent_events row written by one bulk action
//     (Phase 2's bulk opt-in, Phase 3's CSV opt-in) so "how many contacts did
//     this one confirmation cover" is a single query, not row-order-guessing.
//     A single-contact write leaves this NULL. Not a foreign key either — no
//     batches table exists; it's a caller-generated uuid shared across the
//     rows one action produced, purely correlative.
exports.up = (pgm) => {
  pgm.addColumns('consent_events', {
    actor_type: { type: 'text' },
    actor_id: { type: 'uuid' },
    batch_id: { type: 'uuid' },
  });
  pgm.createIndex('consent_events', 'batch_id');
};

exports.down = (pgm) => {
  pgm.dropColumns('consent_events', ['actor_type', 'actor_id', 'batch_id']);
};
