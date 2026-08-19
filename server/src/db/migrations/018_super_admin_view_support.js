// Phase 6 Part B — schema support for the super-admin cross-tenant views
// (routes/superAdmin.js). Each addition here is consumed by a specific view
// and populated by extending metaWebhook.js/messagingService.js in the same
// commit — not speculative columns, each one backs a real field the spec
// asked for:
//
// - wabas.restriction_status: "restriction status" (health view). Populated
//   by extending handleAccountUpdate, which currently only extracts
//   quality_rating from the account_update payload.
// - messages.meta_error_code: "failed sends with Meta error codes" (failures
//   view). messages.error_reason (006_messaging.js) is free text only — no
//   code — even though messagingService.js's catch blocks already have
//   Meta's structured error (err.metaError, including its numeric `code`)
//   and simply discard it before persisting. Threaded through
//   chatsRepo.markFailed/updateStatusByMetaId in this same change.
// - message_templates.rejection_reason: "templates ... rejection reasons"
//   (templates view). Meta's message_template_status_update payload
//   includes a `reason` field for rejections that handleTemplateStatusUpdate
//   currently discards, writing only `status`.
// - meta_webhook_log: "last successful webhook received" (health view) and,
//   as a direct side benefit, the exact thing that was missing to report a
//   webhook handler's duration outside of console.log during last session's
//   production verification (metaWebhook.js:312-317 only ever logged it).
//   One row per POST /webhooks/meta request. No RLS/wasi_app grant — same
//   treatment as audit_log/admin_users (013_tenant_isolation.js): platform-
//   internal, privileged-connection-only, not tenant data.
exports.up = (pgm) => {
  pgm.addColumns('wabas', {
    restriction_status: { type: 'text' },
  });

  pgm.addColumns('messages', {
    meta_error_code: { type: 'integer' },
  });

  pgm.addColumns('message_templates', {
    rejection_reason: { type: 'text' },
  });

  pgm.createTable('meta_webhook_log', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    success: { type: 'boolean', notNull: true },
    duration_ms: { type: 'numeric', notNull: true },
    entries_processed: { type: 'integer', notNull: true, default: 0 },
    waba_ids_touched: { type: 'uuid[]', notNull: true, default: pgm.func("'{}'::uuid[]") },
    error_summary: { type: 'text' },
  });
  // Matches the alerting engine's actual query shape (Part C): "any success
  // row touching waba X in the last 24h" and "last N rows overall".
  pgm.createIndex('meta_webhook_log', 'received_at');
  pgm.createIndex('meta_webhook_log', 'waba_ids_touched', { method: 'gin' });
};

exports.down = (pgm) => {
  pgm.dropTable('meta_webhook_log');
  pgm.dropColumns('message_templates', ['rejection_reason']);
  pgm.dropColumns('messages', ['meta_error_code']);
  pgm.dropColumns('wabas', ['restriction_status']);
};
