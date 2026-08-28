// Fixes a real gap the independent Phase 2 audit found: the 2 Authentication
// entries in templateLibraryContent.js already carried an `auth_options`
// field (codeExpirationMinutes/addSecurityDisclaimer, matching
// message_templates.auth_options' own shape from migration
// 020_template_rich_fields.js) that was never actually persisted or
// prefilled anywhere — dead content implying behavior that didn't happen.
// Purely additive: one nullable jsonb column on the existing
// template_library table, no data loss risk on rollback (this table's
// content is fully reproducible from seedTemplateLibrary.js, same
// reasoning as migration 036's down() for the table itself).
exports.up = (pgm) => {
  pgm.addColumns('template_library', {
    auth_options: { type: 'jsonb' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('template_library', ['auth_options']);
};
