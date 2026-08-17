// Meta's data-deletion callback must return a status URL that actually
// resolves to something (spec §10) — previously it returned a URL that 404'd
// since no route implemented it. Requests default to 'pending' because we
// can't automatically map a Facebook user_id to a specific client's data (a
// WABA is tied to a business, not the individual FB user who connected it —
// see the comment in routes/metaDataDeletion.js); an admin marks one
// 'completed' after manually confirming/purging anything identifiable.

exports.up = (pgm) => {
  pgm.createTable('data_deletion_requests', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    confirmation_code: { type: 'text', notNull: true, unique: true },
    fb_user_id: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'pending', check: "status in ('pending', 'completed')" },
    requested_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    completed_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('data_deletion_requests');
};
