// PLAN.md item 8 — multi-tag contacts, additive to contacts.tag_id, which
// stays the permanent "primary tag" (every existing tag-based
// broadcast/chat targeting keys off it directly — untouched by this
// migration, no breaking replace).
//
// The backfill is insert-only: it copies every existing contacts.tag_id
// into contact_tags so nothing that already relied on "this contact has
// tag X" (item 9's future segment conditions, in particular) silently loses
// visibility into pre-existing tag assignments the moment this table
// becomes the multi-tag source of truth. It does not UPDATE or DELETE
// anything in contacts/tags.
exports.up = (pgm) => {
  pgm.createTable('contact_tags', {
    contact_id: { type: 'uuid', notNull: true, references: 'contacts', onDelete: 'CASCADE' },
    tag_id: { type: 'uuid', notNull: true, references: 'tags', onDelete: 'CASCADE' },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Composite PK via a separate addConstraint call — matches this repo's
  // own precedent (migration 033_message_status_forwards.js) rather than
  // createTable's inline options-object form.
  pgm.addConstraint('contact_tags', 'contact_tags_pkey', {
    primaryKey: ['contact_id', 'tag_id'],
  });
  pgm.createIndex('contact_tags', 'client_id');
  pgm.createIndex('contact_tags', 'tag_id');

  pgm.sql(`grant select, insert, update, delete on contact_tags to wasi_app`);

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql(`alter table contact_tags enable row level security`);
  pgm.sql(`alter table contact_tags force row level security`);
  pgm.sql(`
    create policy tenant_isolation on contact_tags
      using (client_id = ${setting})
      with check (client_id = ${setting})
  `);

  pgm.sql(`
    insert into contact_tags (contact_id, tag_id, client_id)
    select id, tag_id, client_id from contacts where tag_id is not null
    on conflict (contact_id, tag_id) do nothing
  `);
};

exports.down = async (pgm) => {
  // Revision 2's original guard (a bare row-count comparison against
  // contacts.tag_id) was unsound: adding one new multi-tag assignment and
  // removing one backfilled one leaves the counts matching while real data
  // is silently dropped on rollback. This is a real set-membership check
  // instead — every row the backfill itself inserted is, by construction,
  // always a (contact_id, tag_id) pair that also exists as contacts.tag_id;
  // any row that ISN'T is necessarily something added after this migration
  // ran (a new second/third tag, or contacts.tag_id having since changed) —
  // real data this rollback would otherwise destroy with no warning.
  const [{ count }] = await pgm.db.select(`
    select count(*)::int as count from contact_tags ct
    where not exists (
      select 1 from contacts c where c.id = ct.contact_id and c.tag_id = ct.tag_id
    )
  `);
  if (count > 0) {
    throw new Error(
      `Cannot roll back 061_contact_tags_multi: ${count} real tag assignment(s) exist beyond ` +
      `what contacts.tag_id alone would reconstruct. Export/back up first if they need to be kept, then retry this rollback.`
    );
  }

  pgm.sql(`drop policy if exists tenant_isolation on contact_tags`);
  pgm.sql(`alter table contact_tags disable row level security`);
  pgm.sql(`revoke all on contact_tags from wasi_app`);
  pgm.dropTable('contact_tags');
};
