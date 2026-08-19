// Template sync (services/templateSyncService.js) — a client's WABA can
// already have approved templates on Meta before they ever touch Wasi
// (Embedded Signup connects to an existing number, doesn't create a fresh
// one), and nothing in this app has ever read them back. Without this,
// every new client sees an empty template list despite having working
// templates.
//
// meta_template_id: names are unique per WABA, so matching by name alone
// works — but storing Meta's own id makes future operations (this sync's
// own re-runs, anything else keyed off a specific template) unambiguous
// rather than re-deriving identity from a string every time.
//
// orphaned_at: set when a previously-synced local row (one that HAS a
// meta_template_id, i.e. was confirmed to exist on Meta at some point) is
// no longer present in Meta's current list — deleted directly in Business
// Manager, most likely. Deliberately NOT a delete, and deliberately not
// applied to rows with no meta_template_id at all: a local draft never
// submitted to Meta was never "on Meta" to begin with, so it isn't missing
// from anything — sync must never silently destroy that kind of row.
exports.up = (pgm) => {
  pgm.addColumns('message_templates', {
    meta_template_id: { type: 'text' },
    orphaned_at: { type: 'timestamptz' },
  });
  pgm.createIndex('message_templates', 'meta_template_id');
};

exports.down = (pgm) => {
  pgm.dropColumns('message_templates', ['meta_template_id', 'orphaned_at']);
};
