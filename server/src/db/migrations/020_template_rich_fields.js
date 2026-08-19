// Template form rebuild — schema support for header/footer/buttons/sample
// values/Authentication-specific fields. All additive/nullable.
//
// header_type is deliberately NOT constraint-limited to a fixed vocabulary
// at the DB level: media headers (IMAGE/VIDEO/DOCUMENT) are out of scope for
// this pass — they need Meta's separate resumable-upload-session flow
// (POST /{app-id}/uploads -> upload bytes -> h:... handle), which doesn't
// exist anywhere in this codebase yet and isn't being built as a rushed
// sub-case of this form. Only 'NONE'/'TEXT' are accepted right now, and
// that's enforced at the zod schema layer (server/src/utils/validate.js),
// not a DB CHECK — so adding media header support later is a schema/builder
// change, not another migration.
exports.up = (pgm) => {
  pgm.addColumns('message_templates', {
    header_type: { type: 'text' },
    header_content: { type: 'text' },
    footer_text: { type: 'text' },
    buttons: { type: 'jsonb' },
    body_param_examples: { type: 'jsonb' },
    auth_options: { type: 'jsonb' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('message_templates', [
    'header_type',
    'header_content',
    'footer_text',
    'buttons',
    'body_param_examples',
    'auth_options',
  ]);
};
