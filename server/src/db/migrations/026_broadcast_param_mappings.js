// Priority fix, found live during flow-engine production testing:
// broadcastRunner.js's sendOneRecipient has always built
// `templateComponents: []` unconditionally — any broadcast using a template
// with named body/header parameters sends with them unresolved, which Meta
// rejects. This column stores, per broadcast, where each parameter's value
// comes from: a contact field (e.g. customer_name -> contact.name) or a
// static value fixed at broadcast creation. Validated at creation time
// (routes/broadcasts.js) against the chosen template's actual parameters —
// fails there with a clear message if any parameter has no source, rather
// than silently sending unresolved {{...}} text or failing at Meta.
exports.up = (pgm) => {
  pgm.addColumns('broadcasts', {
    param_mappings: { type: 'jsonb', notNull: true, default: '{}' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('broadcasts', ['param_mappings']);
};
