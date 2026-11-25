// Hub API requests Wasi itself refused (build-docs/features/hub-api-rejection-log.md):
// a 4xx/5xx sent by utils/apiError.js's sendApiError for an authenticated
// API key - invalid_phone, consent_required, template_not_approved,
// params_mismatch, validation_failed, rate_limited... Before this, only sends
// that reached Meta left a trace (a messages row), so "why did n8n fail?"
// could not be answered for anything Wasi refused first.
//
// Platform-internal: written and read only through the privileged pool
// (sendApiError, admin Client Detail), so no wasi_app grant - same treatment
// as alert_events / failed_consent_writes. Purged after 30 days
// (alertRunner.js). `api_key_id` is SET NULL so deleting a key keeps the log.

exports.up = (pgm) => {
  pgm.createTable('api_rejections', {
    id: { type: 'bigserial', primaryKey: true },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    api_key_id: { type: 'uuid', references: 'api_keys', onDelete: 'SET NULL' },
    method: { type: 'text', notNull: true },
    path: { type: 'text', notNull: true },
    status: { type: 'integer', notNull: true },
    code: { type: 'text', notNull: true },
    message: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('api_rejections', ['client_id', { name: 'created_at', sort: 'DESC' }]);
  pgm.createIndex('api_rejections', 'created_at');
};

exports.down = (pgm) => {
  pgm.dropTable('api_rejections');
};
