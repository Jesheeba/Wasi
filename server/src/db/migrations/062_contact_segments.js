// PLAN.md item 9 — AND/OR audience segment builder. A named, reusable
// filter (tag membership via item 8's contact_tags, attribute comparisons
// via item 7's contact_attribute_values, opt_in_status) selectable as a
// third broadcast audience type alongside the existing tag_id/
// contact_list_id.
//
// filter_json shape (validated at the app layer, utils/validate.js, not by
// a DB CHECK — matches this repo's existing jsonb-column convention, e.g.
// message_templates.body_param_examples): a flat list, one top-level
// combinator, per the plan's own decision (not nested groups):
//   { "combinator": "AND"|"OR", "conditions": [
//       { "field": "tag", "op": "eq", "value": "<tagId>" },
//       { "field": "attribute", "attributeId": "<id>", "op": "eq"|"gt"|"lt"|"contains", "value": "..." },
//       { "field": "opt_in_status", "op": "eq", "value": "opted_in"|"opted_out"|"unknown" }
//   ] }
exports.up = (pgm) => {
  pgm.createTable('contact_segments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    filter_json: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('contact_segments', 'client_id');

  pgm.sql(`grant select, insert, update, delete on contact_segments to wasi_app`);

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql(`alter table contact_segments enable row level security`);
  pgm.sql(`alter table contact_segments force row level security`);
  pgm.sql(`
    create policy tenant_isolation on contact_segments
      using (client_id = ${setting})
      with check (client_id = ${setting})
  `);

  // Widens broadcasts' audience-exclusivity constraint from "at most one of
  // 2" (migration 039) to "at most one of 3" — byte-for-byte as restrictive
  // as the old one for the two pre-existing columns (still forbids any
  // 2-of-2 among tag_id/contact_list_id), so this is a non-breaking
  // widening, not a behavior change to anything already in production. 0
  // selected still means "everyone", exactly as 039 already documented and
  // intended — this migration carries that forward, it doesn't introduce it.
  pgm.dropConstraint('broadcasts', 'broadcasts_audience_not_both');
  pgm.addColumn('broadcasts', {
    segment_id: { type: 'uuid', references: 'contact_segments', onDelete: 'SET NULL' },
  });
  pgm.addConstraint('broadcasts', 'broadcasts_audience_at_most_one', {
    check: '(tag_id is not null)::int + (contact_list_id is not null)::int + (segment_id is not null)::int <= 1',
  });
};

exports.down = async (pgm) => {
  // Real client-defined segments (or a broadcast that used one) existing by
  // the time a rollback runs on this shared database — same live-row-guard
  // discipline as every other migration in this plan.
  const [{ count: segCount }] = await pgm.db.select('select count(*)::int as count from contact_segments');
  const [{ count: usedCount }] = await pgm.db.select('select count(*)::int as count from broadcasts where segment_id is not null');
  if (segCount > 0 || usedCount > 0) {
    throw new Error(
      `Cannot roll back 062_contact_segments: ${segCount} real segment(s) and ${usedCount} broadcast(s) referencing one exist. ` +
      `Export/back up first if they need to be kept, then retry this rollback.`
    );
  }

  pgm.dropConstraint('broadcasts', 'broadcasts_audience_at_most_one');
  pgm.dropColumns('broadcasts', ['segment_id']);
  pgm.addConstraint('broadcasts', 'broadcasts_audience_not_both', {
    check: 'tag_id is null or contact_list_id is null',
  });

  pgm.sql(`drop policy if exists tenant_isolation on contact_segments`);
  pgm.sql(`alter table contact_segments disable row level security`);
  pgm.sql(`revoke all on contact_segments from wasi_app`);
  pgm.dropTable('contact_segments');
};
