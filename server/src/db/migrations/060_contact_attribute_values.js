// PLAN.md item 7 — per-contact custom attribute values. contact_attributes
// (migration 011) has only ever been type definitions ("this client has a
// 'city' attribute of type text") with nowhere to store a value per
// contact until now.
//
// value stays `text` (no per-type columns) — matches this repo's existing
// loose-storage convention (e.g. message_templates.body_param_examples);
// the per-type check (number/date/boolean format) is write-time app-layer
// validation (routes/contacts.js, using utils/validate.js's
// validateContactAttributeValue), not a DB CHECK, so a later type-format
// tightening doesn't need a migration.
//
// UNIQUE(contact_id, attribute_id) (no client_id in the constraint, same as
// contact_attributes_client_name_unique on the parent table not needing
// client_id either — contact_id and attribute_id both already imply a
// single client) is what makes the route's upsert a plain
// ON CONFLICT (contact_id, attribute_id) DO UPDATE.
exports.up = (pgm) => {
  pgm.createTable('contact_attribute_values', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    contact_id: { type: 'uuid', notNull: true, references: 'contacts', onDelete: 'CASCADE' },
    attribute_id: { type: 'uuid', notNull: true, references: 'contact_attributes', onDelete: 'CASCADE' },
    value: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('contact_attribute_values', 'contact_attribute_values_contact_attribute_unique', {
    unique: ['contact_id', 'attribute_id'],
  });
  pgm.createIndex('contact_attribute_values', 'client_id');
  pgm.createIndex('contact_attribute_values', 'contact_id');

  pgm.sql(`grant select, insert, update, delete on contact_attribute_values to wasi_app`);

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql(`alter table contact_attribute_values enable row level security`);
  pgm.sql(`alter table contact_attribute_values force row level security`);
  pgm.sql(`
    create policy tenant_isolation on contact_attribute_values
      using (client_id = ${setting})
      with check (client_id = ${setting})
  `);
};

exports.down = async (pgm) => {
  // Same discipline as every other tenant-table down() in this plan — real
  // per-contact business data (a client's actual custom field values)
  // could exist by the time a rollback runs on this shared database.
  const [{ count }] = await pgm.db.select('select count(*)::int as count from contact_attribute_values');
  if (count > 0) {
    throw new Error(
      `Cannot roll back 060_contact_attribute_values: ${count} real value(s) exist. ` +
      `Export/back up first if they need to be kept, then retry this rollback.`
    );
  }

  pgm.sql(`drop policy if exists tenant_isolation on contact_attribute_values`);
  pgm.sql(`alter table contact_attribute_values disable row level security`);
  pgm.sql(`revoke all on contact_attribute_values from wasi_app`);
  pgm.dropTable('contact_attribute_values');
};
