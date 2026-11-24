// Template category changes made by Meta (build-docs/features/template-category-change.md).
// Since April 2025 Meta approves a template submitted as Utility as Marketing
// when it judges the content to be marketing, and can also recategorise an
// approved template later (template_category_update webhook, with 24 hours'
// notice). Wasi used to overwrite `category` on sync with no record, so
// nothing told the client their "Utility" template now costs Marketing
// rates and needs opt-in.
//   previous_category     - the category before Meta changed it
//   category_changed_at   - when Wasi learned of the change
//   upcoming_category     - a change Meta has announced but not made yet
//   upcoming_category_at  - when Meta said it takes effect
// message_templates has a table-level wasi_app grant (migration 013), so
// new columns need no grant change.
exports.up = (pgm) => {
  pgm.addColumns('message_templates', {
    previous_category: { type: 'text' },
    category_changed_at: { type: 'timestamptz' },
    upcoming_category: { type: 'text' },
    upcoming_category_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('message_templates', ['previous_category', 'category_changed_at', 'upcoming_category', 'upcoming_category_at']);
};
