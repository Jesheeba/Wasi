// Pure-function content validation — deliberately doesn't import pool.js/
// app.js (same reasoning as dbSafety.test.js and apiV1ErrorHandler.test.js:
// no DB/server needed), so it runs with no DATABASE_URL guard involved and
// gives fast, unambiguous feedback the moment content.js changes. This is
// the actual enforcement of wasi-master-plan.md §2.3's "every template
// manually checked against Meta's real rejection reasons" — running the
// same validateTemplateText/validateHeaderText functions the real
// submission flow uses, not a hand-eyeballed claim.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TEMPLATE_LIBRARY_CONTENT, ECOMMERCE, HEALTHCARE, GENERAL } = require('../src/db/templateLibraryContent');
const { validateLibraryContent, validateLibraryEntry } = require('../src/utils/templateLibraryValidation');
const { validateTemplateText } = require('../src/utils/templateParams');

test('every seeded template passes real Meta-rejection-reason validation, 0 errors', () => {
  const errors = validateLibraryContent(TEMPLATE_LIBRARY_CONTENT);
  assert.deepEqual(errors, []);
});

test('this content batch covers exactly the 3 planned industries with 12 templates each', () => {
  assert.equal(ECOMMERCE.length, 12);
  assert.equal(HEALTHCARE.length, 12);
  assert.equal(GENERAL.length, 12);
  assert.equal(TEMPLATE_LIBRARY_CONTENT.length, 36);
});

test('every entry has a unique (industry, use_case) pair — matches the DB unique constraint (migration 037)', () => {
  const keys = TEMPLATE_LIBRARY_CONTENT.map((t) => `${t.industry}::${t.use_case}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('every entry spans a real Meta category and none silently defaults to an unexpected value', () => {
  const categories = new Set(TEMPLATE_LIBRARY_CONTENT.map((t) => t.category));
  for (const c of categories) {
    assert.ok(['Marketing', 'Utility', 'Authentication'].includes(c), `unexpected category: ${c}`);
  }
  // Every industry must span more than one category (per §2.3's "spanning
  // all relevant Meta categories") — not just a pile of Utility templates.
  for (const industry of ['E-commerce', 'Healthcare', 'General/Other']) {
    const industryCategories = new Set(TEMPLATE_LIBRARY_CONTENT.filter((t) => t.industry === industry).map((t) => t.category));
    assert.ok(industryCategories.size >= 2, `${industry} should span more than one Meta category, got: ${[...industryCategories]}`);
  }
});

test('every non-Authentication entry has a named-parameter body that would actually pass routes/templates.js\'s real validateTemplateText', () => {
  for (const entry of TEMPLATE_LIBRARY_CONTENT) {
    if (entry.category === 'Authentication') continue;
    const result = validateTemplateText(entry.body, { label: 'Body' });
    assert.equal(result.valid, true, `${entry.industry}/${entry.use_case}: ${result.errors.join('; ')}`);
  }
});

test('every named param in every body has a real (non-empty, non-placeholder-looking) sample value', () => {
  for (const entry of TEMPLATE_LIBRARY_CONTENT) {
    if (entry.category === 'Authentication') continue;
    const { params } = validateTemplateText(entry.body, { label: 'Body' });
    for (const p of params) {
      const value = entry.sample_values[p];
      assert.ok(value, `${entry.industry}/${entry.use_case}: {{${p}}} has no sample value`);
      assert.notEqual(value.trim(), '', `${entry.industry}/${entry.use_case}: {{${p}}} sample value is blank`);
    }
  }
});

test('no template body overclaims Meta approval ("guaranteed approved" language) — §2.6', () => {
  const overclaimPattern = /guaranteed\s*(to\s*be\s*)?approv|100%\s*approv|always\s*approv/i;
  for (const entry of TEMPLATE_LIBRARY_CONTENT) {
    assert.doesNotMatch(entry.body || '', overclaimPattern, `${entry.industry}/${entry.use_case} body overclaims approval`);
    assert.doesNotMatch(entry.title || '', overclaimPattern, `${entry.industry}/${entry.use_case} title overclaims approval`);
  }
});

test('validateLibraryEntry catches a deliberately-broken entry (regression guard for the validator itself)', () => {
  const brokenNumberedParam = { industry: 'Test', use_case: 'broken', category: 'Utility', title: 'Broken', body: 'Hi {{1}}, thanks!', sample_values: {} };
  const errorsA = validateLibraryEntry(brokenNumberedParam, 0);
  assert.ok(errorsA.length > 0, 'a numbered {{1}} param must be rejected');

  const startsWithVariable = { industry: 'Test', use_case: 'broken2', category: 'Utility', title: 'Broken', body: '{{customer_name}}, your order shipped today for real', sample_values: { customer_name: 'Priya' } };
  const errorsB = validateLibraryEntry(startsWithVariable, 1);
  assert.ok(errorsB.length > 0, 'a variable at the start of the body must be rejected');

  const tooFewWords = { industry: 'Test', use_case: 'broken3', category: 'Utility', title: 'Broken', body: 'Hi {{customer_name}}, thanks!', sample_values: { customer_name: 'Priya' } };
  const errorsC = validateLibraryEntry(tooFewWords, 2);
  assert.ok(errorsC.length > 0, 'the exact live-verified words-ratio rejection case from templateParams.js\'s own comment must be caught');

  const missingSampleValue = { industry: 'Test', use_case: 'broken4', category: 'Utility', title: 'Broken', body: 'Hi {{customer_name}}, your recent order has shipped and is on the way to you.', sample_values: {} };
  const errorsD = validateLibraryEntry(missingSampleValue, 3);
  assert.ok(errorsD.length > 0, 'a missing sample value for a real param must be rejected');
});
