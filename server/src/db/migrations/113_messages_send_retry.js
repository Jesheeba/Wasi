// Send retry queue (build-docs/features/send-retry-queue.md). An outbound
// message that could not reach Meta because of a network or temporary Meta
// error stays 'pending' with the exact Meta call in send_request (function +
// arguments, never the access token) and is replayed by
// services/messageRetryRunner.js at next_retry_at.
//
// No grant: messages already has a table-level wasi_app grant, which covers
// new columns. Excluded from webhook forwarding in metaWebhook.js.

exports.up = (pgm) => {
  pgm.addColumns('messages', {
    retry_count: { type: 'integer', notNull: true, default: 0 },
    next_retry_at: { type: 'timestamptz' },
    send_request: { type: 'jsonb' },
  });
  pgm.sql(`create index messages_retry_due_idx on messages (next_retry_at) where status = 'pending' and send_request is not null`);
};

exports.down = (pgm) => {
  pgm.sql('drop index if exists messages_retry_due_idx');
  pgm.dropColumns('messages', ['retry_count', 'next_retry_at', 'send_request']);
};
