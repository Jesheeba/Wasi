// Limited-Time-Offer templates (build-docs/features/limited-time-offer-templates.md).
// Nullable, no default - only a Marketing template with an author-chosen
// offer strip sets this; every other template (the overwhelming majority)
// leaves it null, same convention as header_content/footer_text/buttons.
exports.up = (pgm) => {
  pgm.addColumns('message_templates', {
    limited_time_offer: { type: 'jsonb' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('message_templates', ['limited_time_offer']);
};
