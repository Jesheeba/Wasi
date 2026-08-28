// Follow-up to 036_template_library.js — adds the stable natural key
// seedTemplateLibrary.js needs to be idempotently re-runnable the same way
// db/seed.js already is (`on conflict (id) do update`). Without this, a
// re-seed (e.g. adding/editing content) would have to either INSERT
// duplicates or DELETE-then-INSERT — the latter would generate new row ids
// each time, orphaning any template_library_usage row a real client had
// already recorded against the old id despite ON DELETE CASCADE (the usage
// row would simply vanish along with it). A unique (industry, use_case)
// constraint lets the seed script upsert by that key, keeping the same id
// stable across re-seeds so usage history is never silently lost.
exports.up = (pgm) => {
  pgm.addConstraint('template_library', 'template_library_industry_use_case_unique', {
    unique: ['industry', 'use_case'],
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('template_library', 'template_library_industry_use_case_unique');
};
