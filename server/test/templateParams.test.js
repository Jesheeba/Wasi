// Pure unit tests — no network, no database. Named-parameter parsing,
// validation, and Meta payload-shape construction (server/src/utils/
// templateParams.js + the payload builders in metaClient.js) are all plain
// functions, so these run without a real Meta App or Postgres.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractPlaceholders,
  isPurelyNumeric,
  isVariableAtStartOrEnd,
  validateTemplateText,
  defaultExampleFor,
} = require('../src/utils/templateParams');
const { buildTemplateCreatePayload, buildNamedBodyComponents, TemplateValidationError } = require('../src/utils/metaClient');

test('extractPlaceholders finds every {{name}} with position info', () => {
  const matches = extractPlaceholders('Hi {{customer_name}}, order {{order_number}} shipped.');
  assert.deepEqual(matches.map((m) => m.name), ['customer_name', 'order_number']);
  assert.equal(matches[0].raw, '{{customer_name}}');
});

test('extractPlaceholders tolerates whitespace inside braces', () => {
  const matches = extractPlaceholders('Hi {{ customer_name }}!');
  assert.deepEqual(matches.map((m) => m.name), ['customer_name']);
});

test('isPurelyNumeric distinguishes legacy positional names from real names', () => {
  assert.equal(isPurelyNumeric('1'), true);
  assert.equal(isPurelyNumeric('42'), true);
  assert.equal(isPurelyNumeric('customer_name'), false);
  assert.equal(isPurelyNumeric('order_2'), false); // digits mixed with letters is a valid named param
});

test('isVariableAtStartOrEnd flags a variable as the very first token', () => {
  assert.equal(isVariableAtStartOrEnd('{{customer_name}}, welcome!'), true);
});

test('isVariableAtStartOrEnd flags a variable as the very last token', () => {
  assert.equal(isVariableAtStartOrEnd('Welcome, {{customer_name}}'), true);
});

test('isVariableAtStartOrEnd allows a variable in the middle', () => {
  assert.equal(isVariableAtStartOrEnd('Hi {{customer_name}}, welcome!'), false);
});

test('isVariableAtStartOrEnd ignores surrounding whitespace when checking edges', () => {
  assert.equal(isVariableAtStartOrEnd('  {{customer_name}}, welcome!  '), true);
});

test('validateTemplateText: plain text with no placeholders is valid, format "none"', () => {
  const result = validateTemplateText('Thanks for shopping with us!');
  assert.equal(result.valid, true);
  assert.equal(result.paramFormat, 'none');
  assert.deepEqual(result.params, []);
});

test('validateTemplateText: named parameters in the middle are valid', () => {
  const result = validateTemplateText('Hi {{customer_name}}, your order #{{order_number}} shipped.');
  assert.equal(result.valid, true);
  assert.equal(result.paramFormat, 'named');
  assert.deepEqual(result.params, ['customer_name', 'order_number']);
});

test('validateTemplateText: numbered parameters are rejected — Meta no longer accepts them', () => {
  const result = validateTemplateText('Hi {{1}}, your order #{{2}} shipped.');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /numbered parameters/i);
});

test('validateTemplateText: purely numeric names are rejected even alone', () => {
  const result = validateTemplateText('Your code is {{1}}.');
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /numbered parameters/i);
});

test('validateTemplateText: mixing numbered and named in one template is rejected', () => {
  const result = validateTemplateText('Hi {{customer_name}}, order {{1}} shipped.');
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /mixes numbered and named/i);
});

test('validateTemplateText: a variable at the start is rejected', () => {
  const result = validateTemplateText('{{customer_name}}, your order shipped.');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /start or end/i);
});

test('validateTemplateText: a variable at the end is rejected', () => {
  const result = validateTemplateText('Your order shipped, {{customer_name}}');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /start or end/i);
});

test('validateTemplateText: duplicate param names collapse to one entry', () => {
  const result = validateTemplateText('Hi {{customer_name}}, thanks {{customer_name}}!');
  assert.equal(result.valid, true);
  assert.deepEqual(result.params, ['customer_name']);
});

test('defaultExampleFor derives a readable placeholder from a snake_case name', () => {
  assert.equal(defaultExampleFor('customer_name'), 'Customer Name');
  assert.equal(defaultExampleFor('otp_code'), 'Otp Code');
  assert.equal(defaultExampleFor('id'), 'Id');
});

test('buildTemplateCreatePayload: no variables -> no parameter_format, no example', () => {
  const payload = buildTemplateCreatePayload({
    name: 'shipping_notice',
    category: 'Utility',
    body: 'Your order has shipped.',
  });
  assert.equal(payload.parameter_format, undefined);
  assert.equal(payload.components[0].type, 'BODY');
  assert.equal(payload.components[0].text, 'Your order has shipped.');
  assert.equal(payload.components[0].example, undefined);
});

test('buildTemplateCreatePayload: named variables -> parameter_format "named" + example.body_text_named_params', () => {
  const payload = buildTemplateCreatePayload({
    name: 'order_status_update',
    category: 'Utility',
    body: 'Hi {{customer_name}}, order #{{order_number}} shipped.',
  });
  assert.equal(payload.parameter_format, 'named');
  assert.deepEqual(payload.components[0].example, {
    body_text_named_params: [
      { param_name: 'customer_name', example: 'Customer Name' },
      { param_name: 'order_number', example: 'Order Number' },
    ],
  });
});

test('buildTemplateCreatePayload: category is uppercased (pre-existing behavior, unchanged)', () => {
  const payload = buildTemplateCreatePayload({ name: 'x', category: 'marketing', body: 'Hello there.' });
  assert.equal(payload.category, 'MARKETING');
});

test('buildTemplateCreatePayload: throws TemplateValidationError for numbered params, not a network call', () => {
  assert.throws(
    () => buildTemplateCreatePayload({ name: 'x', category: 'Utility', body: 'Hi {{1}}, order shipped.' }),
    TemplateValidationError
  );
});

test('buildNamedBodyComponents: builds the send-time named-parameter shape', () => {
  const components = buildNamedBodyComponents({ customer_name: 'Alex', order_number: '860198' });
  assert.deepEqual(components, [{
    type: 'body',
    parameters: [
      { type: 'text', parameter_name: 'customer_name', text: 'Alex' },
      { type: 'text', parameter_name: 'order_number', text: '860198' },
    ],
  }]);
});

test('buildNamedBodyComponents: empty/no values -> empty array, matches sendTemplateMessage default', () => {
  assert.deepEqual(buildNamedBodyComponents({}), []);
  assert.deepEqual(buildNamedBodyComponents(undefined), []);
});
