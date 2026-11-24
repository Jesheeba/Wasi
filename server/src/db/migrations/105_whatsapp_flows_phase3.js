// Forms phase 3 (build-docs/features/whatsapp-flows.md).
// whatsapp_flows.attribute_map: { "<form field>": "<contact_attributes.id>" }.
//   A completed form copies those answers onto the contact.
// whatsapp_flows.template_name: the WhatsApp template (with an "open form"
//   FLOW button) created for this form, so it can be sent outside the 24h
//   window. Its approval status lives on message_templates, as for any
//   template.
// whatsapp_flows already has a wasi_app grant + RLS (095); new columns are
// covered by the table-level grant.
exports.up = (pgm) => {
  pgm.addColumns('whatsapp_flows', {
    attribute_map: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    template_name: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('whatsapp_flows', ['attribute_map', 'template_name']);
};
