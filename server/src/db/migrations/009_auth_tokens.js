// Password reset + email verification for both clients and admins, via one
// reusable token table (only the hash is stored — the raw token exists only
// in the emailed link, same principle as never storing a plaintext password).

exports.up = (pgm) => {
  pgm.createTable('auth_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    subject_type: { type: 'text', notNull: true, check: "subject_type in ('client', 'admin')" },
    subject_id: { type: 'uuid', notNull: true },
    purpose: { type: 'text', notNull: true, check: "purpose in ('password_reset', 'email_verification')" },
    token_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('auth_tokens', 'token_hash');
  pgm.createIndex('auth_tokens', ['subject_type', 'subject_id']);

  pgm.addColumn('clients', {
    email_verified: { type: 'boolean', notNull: true, default: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('clients', 'email_verified');
  pgm.dropTable('auth_tokens');
};
