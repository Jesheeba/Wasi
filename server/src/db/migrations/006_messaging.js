// Real WhatsApp Cloud API send/receive support: track Meta's message id (for
// idempotent webhook ingestion + delivery status updates), a real lifecycle
// status per message, the WhatsApp canonical sender id per contact, and the
// template language Meta's template-send API requires.

exports.up = (pgm) => {
  pgm.addColumns('messages', {
    meta_message_id: { type: 'text' },
    status: {
      type: 'text',
      notNull: true,
      default: 'sent',
      check: "status in ('pending','sent','delivered','read','failed')",
    },
    error_reason: { type: 'text' },
  });
  pgm.addConstraint('messages', 'messages_meta_message_id_unique', { unique: ['meta_message_id'] });

  pgm.addColumn('contacts', {
    wa_id: { type: 'text' },
  });

  pgm.addColumn('message_templates', {
    language: { type: 'text', notNull: true, default: 'en_US' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('message_templates', 'language');
  pgm.dropColumn('contacts', 'wa_id');
  pgm.dropConstraint('messages', 'messages_meta_message_id_unique');
  pgm.dropColumns('messages', ['meta_message_id', 'status', 'error_reason']);
};
