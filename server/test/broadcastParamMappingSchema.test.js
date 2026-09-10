// broadcastCreateSchema / broadcastParamMappingSchema (server/src/utils/validate.js)
// — pure zod schema tests, no DB. Added alongside the campaign modal's new
// contact_attribute mapping source (PLAN.md campaign-paramMappings-UI
// follow-up) — the New Campaign modal previously 400'd on every template
// with a {{variable}} because it never sent paramMappings at all; this
// covers the schema's acceptance of the now-3-way source, and that it still
// rejects the same malformed shapes it always has.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { broadcastCreateSchema } = require('../src/utils/validate');

const BASE = { title: 'Sale', templateName: 'my_template' };
const ATTR_ID = '11111111-1111-1111-1111-111111111111';

test('broadcastCreateSchema: accepts a contact_attribute paramMappings entry', () => {
  const result = broadcastCreateSchema.safeParse({
    ...BASE,
    paramMappings: { favorite_color: { source: 'contact_attribute', attributeId: ATTR_ID } },
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.data.paramMappings, {
    favorite_color: { source: 'contact_attribute', attributeId: ATTR_ID },
  });
});

test('broadcastCreateSchema: rejects a contact_attribute entry with no attributeId', () => {
  const result = broadcastCreateSchema.safeParse({
    ...BASE,
    paramMappings: { favorite_color: { source: 'contact_attribute' } },
  });
  assert.equal(result.success, false);
});

test('broadcastCreateSchema: rejects a contact_attribute entry with a non-uuid attributeId', () => {
  const result = broadcastCreateSchema.safeParse({
    ...BASE,
    paramMappings: { favorite_color: { source: 'contact_attribute', attributeId: 'not-a-uuid' } },
  });
  assert.equal(result.success, false);
});

test('broadcastCreateSchema: contact_field and static mappings still validate exactly as before', () => {
  const result = broadcastCreateSchema.safeParse({
    ...BASE,
    paramMappings: {
      customer_name: { source: 'contact_field', field: 'name' },
      offer_code: { source: 'static', value: 'SAVE20' },
    },
  });
  assert.equal(result.success, true);
});

test('broadcastCreateSchema: still rejects an unknown source string', () => {
  const result = broadcastCreateSchema.safeParse({
    ...BASE,
    paramMappings: { favorite_color: { source: 'made_up_source' } },
  });
  assert.equal(result.success, false);
});

test('broadcastCreateSchema: still rejects a static mapping with no value', () => {
  const result = broadcastCreateSchema.safeParse({
    ...BASE,
    paramMappings: { offer_code: { source: 'static' } },
  });
  assert.equal(result.success, false);
});

test('broadcastCreateSchema: paramMappings is still optional (a variable-free template sends none)', () => {
  const result = broadcastCreateSchema.safeParse(BASE);
  assert.equal(result.success, true);
  assert.equal(result.data.paramMappings, undefined);
});
