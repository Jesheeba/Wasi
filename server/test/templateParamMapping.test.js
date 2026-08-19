// Template {{named}} parameter resolution (server/src/utils/templateParamMapping.js) —
// shared between broadcastRunner.js (the priority fix — a broadcast's
// param_mappings, set once at creation) and flowEngine.js's send_template
// node (config.paramMappings). Pure-function testing — no DB, no network —
// same reasoning templateSyncService.test.js and flowEngine.test.js
// document for their pure halves. Priority fix found live during
// production testing: broadcastRunner's sendOneRecipient built
// `templateComponents: []` unconditionally, so any template with named
// parameters sent with them unresolved.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveParamValues, buildTemplateComponents } = require('../src/utils/templateParamMapping');

// --- resolveParamValues ---

test('resolveParamValues: a contact_field mapping reads from the contact', () => {
  const mappings = { customer_name: { source: 'contact_field', field: 'name' } };
  const contact = { name: 'Riyaz', phone: '919092766740' };
  assert.deepEqual(resolveParamValues(mappings, contact), { customer_name: 'Riyaz' });
});

test('resolveParamValues: a static mapping ignores the contact entirely', () => {
  const mappings = { plan_name: { source: 'static', value: 'Pro' } };
  const contact = { name: 'Riyaz', phone: '919092766740' };
  assert.deepEqual(resolveParamValues(mappings, contact), { plan_name: 'Pro' });
});

test('resolveParamValues: static and contact_field mappings combine in one broadcast', () => {
  const mappings = {
    customer_name: { source: 'contact_field', field: 'name' },
    offer_code: { source: 'static', value: 'SAVE20' },
  };
  const contact = { name: 'Riyaz', phone: '919092766740' };
  assert.deepEqual(resolveParamValues(mappings, contact), { customer_name: 'Riyaz', offer_code: 'SAVE20' });
});

test('resolveParamValues: no mappings resolves to an empty object, not a throw', () => {
  assert.deepEqual(resolveParamValues({}, { name: 'Riyaz' }), {});
  assert.deepEqual(resolveParamValues(null, { name: 'Riyaz' }), {});
});

// --- buildTemplateComponents ---

test('buildTemplateComponents: a body-only template gets a body component with the resolved value', () => {
  const template = { body: 'Hi {{customer_name}}, thanks for your order.', header_type: null, header_content: null };
  const components = buildTemplateComponents(template, { customer_name: 'Riyaz' });
  assert.equal(components.length, 1);
  assert.equal(components[0].type, 'body');
  assert.deepEqual(components[0].parameters, [{ type: 'text', parameter_name: 'customer_name', text: 'Riyaz' }]);
});

test('buildTemplateComponents: a param appearing in both header and body is split correctly', () => {
  const template = {
    body: 'Hi {{customer_name}}, your order shipped.',
    header_type: 'TEXT',
    header_content: 'Hello {{customer_name}}',
  };
  const components = buildTemplateComponents(template, { customer_name: 'Riyaz' });
  const header = components.find((c) => c.type === 'header');
  const body = components.find((c) => c.type === 'body');
  assert.deepEqual(header.parameters, [{ type: 'text', parameter_name: 'customer_name', text: 'Riyaz' }]);
  assert.deepEqual(body.parameters, [{ type: 'text', parameter_name: 'customer_name', text: 'Riyaz' }]);
});

test('buildTemplateComponents: a template with no {{params}} at all produces no components', () => {
  const template = { body: 'Thanks for shopping with us!', header_type: null, header_content: null };
  assert.deepEqual(buildTemplateComponents(template, {}), []);
});

test('buildTemplateComponents: an extra resolved value not present in the template text is dropped, not sent', () => {
  const template = { body: 'Hi {{customer_name}}!', header_type: null, header_content: null };
  const components = buildTemplateComponents(template, { customer_name: 'Riyaz', unused_param: 'ignored' });
  assert.equal(components.length, 1);
  assert.deepEqual(components[0].parameters, [{ type: 'text', parameter_name: 'customer_name', text: 'Riyaz' }]);
});
