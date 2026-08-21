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
  countWords,
  minWordsRequired,
  findMalformedPlaceholders,
  validateTemplateText,
  validateHeaderText,
  defaultExampleFor,
} = require('../src/utils/templateParams');
const { buildTemplateCreatePayload, buildNamedBodyComponents, TemplateValidationError } = require('../src/utils/metaClient');
const { messageTemplateCreateSchema } = require('../src/utils/validate');

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
  const result = validateTemplateText('Hi {{customer_name}}, your order #{{order_number}} has shipped and is on its way.');
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

test('validateTemplateText: duplicate param names collapse to one entry in params, but still count twice for the words ratio', () => {
  const result = validateTemplateText('Hi {{customer_name}}, thanks so much {{customer_name}}, we appreciate you!');
  assert.equal(result.valid, true);
  assert.deepEqual(result.params, ['customer_name']);
});

test('validateTemplateText: rejects a real body that Meta rejected live (error 2388293 regression)', () => {
  // The exact body that triggered error_subcode 2388293 ("Params Words
  // Ratio Exceeds Limit") against real Meta during Phase 2 verification —
  // must be caught locally now, not just by the round trip to Meta.
  const result = validateTemplateText('Hello {{customer_name}}, thanks!');
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /too few words/i);
  assert.match(result.errors.join(' '), /2388293/);
});

test('validateTemplateText: words-ratio rejection message states the actual counts', () => {
  const result = validateTemplateText('Hi {{a}} {{b}} {{c}}.');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /too few words for its 3 parameters/i);
  assert.match(result.errors[0], new RegExp(`needs at least ${minWordsRequired(3)}`));
});

test('countWords / minWordsRequired: formula matches the documented reverse-engineered rule (3 * params + 2)', () => {
  assert.equal(countWords('Hello {{customer_name}}, thanks!'), 3);
  assert.equal(minWordsRequired(1), 5);
  assert.equal(minWordsRequired(2), 8);
  assert.equal(minWordsRequired(0), 2);
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
    body: 'Hi {{customer_name}}, your order #{{order_number}} has shipped and is on its way.',
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

test('findMalformedPlaceholders: a capitalized name is flagged, not silently ignored', () => {
  const found = findMalformedPlaceholders('Hi {{Customer}}, thanks for your order.');
  assert.equal(found.length, 1);
  assert.equal(found[0].raw, '{{Customer}}');
});

test('findMalformedPlaceholders: a space inside braces is flagged', () => {
  const found = findMalformedPlaceholders('Hi {{customer name}}, thanks.');
  assert.equal(found.length, 1);
  assert.equal(found[0].raw, '{{customer name}}');
});

test('findMalformedPlaceholders: a valid named or numbered parameter is not flagged', () => {
  assert.equal(findMalformedPlaceholders('Hi {{customer_name}}, order shipped.').length, 0);
  assert.equal(findMalformedPlaceholders('Hi {{1}}, order shipped.').length, 0);
});

test('validateTemplateText: a capitalized parameter name is rejected with a specific message, not silently accepted as literal text', () => {
  const result = validateTemplateText('Hi {{Customer}}, your order has been shipped. Delivery tracking will be updated soon.');
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /isn't a valid parameter name/i);
  assert.match(result.errors.join(' '), /\{\{Customer\}\}/);
});

test('validateHeaderText: a capitalized parameter name is rejected the same way', () => {
  const result = validateHeaderText('Order #{{Number}}');
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /isn't a valid parameter name/i);
});

test('validateHeaderText: plain text with no placeholder is valid', () => {
  const result = validateHeaderText('Your Order Update');
  assert.equal(result.valid, true);
  assert.deepEqual(result.params, []);
});

test('validateHeaderText: one named parameter is valid', () => {
  const result = validateHeaderText('Order #{{order_number}}');
  assert.equal(result.valid, true);
  assert.deepEqual(result.params, ['order_number']);
});

test('validateHeaderText: rejects more than one variable', () => {
  const result = validateHeaderText('{{customer_name}} — order {{order_number}}');
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /at most one variable/i);
});

test('validateHeaderText: rejects numbered parameters, same as body', () => {
  const result = validateHeaderText('Order #{{1}}');
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /numbered parameter/i);
});

test('buildTemplateCreatePayload: author-supplied bodyParamExamples wins over defaultExampleFor', () => {
  const payload = buildTemplateCreatePayload({
    name: 'order_status_update',
    category: 'Utility',
    body: 'Hi {{customer_name}}, your order has shipped.',
    bodyParamExamples: { customer_name: 'Riyaz' },
  });
  assert.deepEqual(payload.components[0].example.body_text_named_params, [
    { param_name: 'customer_name', example: 'Riyaz' },
  ]);
});

test('buildTemplateCreatePayload: TEXT header adds a HEADER component ahead of BODY', () => {
  const payload = buildTemplateCreatePayload({
    name: 'order_status_update',
    category: 'Utility',
    body: 'Hi {{customer_name}}, your order has shipped.',
    bodyParamExamples: { customer_name: 'Riyaz' },
    header: { type: 'TEXT', text: 'Shipping Update' },
  });
  assert.equal(payload.components[0].type, 'HEADER');
  assert.equal(payload.components[0].format, 'TEXT');
  assert.equal(payload.components[0].text, 'Shipping Update');
  assert.equal(payload.components[1].type, 'BODY');
});

test('buildTemplateCreatePayload: throws for a media header type with no uploaded handle', () => {
  assert.throws(
    () => buildTemplateCreatePayload({
      name: 'x', category: 'Utility', body: 'Hi {{customer_name}}, thanks for your order.',
      bodyParamExamples: { customer_name: 'Riyaz' },
      header: { type: 'IMAGE' },
    }),
    TemplateValidationError
  );
});

test('buildTemplateCreatePayload: a media header with a handle builds header_handle example, ahead of BODY', () => {
  const payload = buildTemplateCreatePayload({
    name: 'x', category: 'Utility', body: 'Hi {{customer_name}}, thanks for your order.',
    bodyParamExamples: { customer_name: 'Riyaz' },
    header: { type: 'IMAGE', handle: 'upload:abc123' },
  });
  assert.deepEqual(payload.components[0], {
    type: 'HEADER', format: 'IMAGE', example: { header_handle: ['upload:abc123'] },
  });
  assert.equal(payload.components[1].type, 'BODY');
});

test('buildTemplateCreatePayload: footer and buttons are appended after BODY', () => {
  const payload = buildTemplateCreatePayload({
    name: 'order_status_update',
    category: 'Utility',
    body: 'Hi {{customer_name}}, your order has shipped.',
    bodyParamExamples: { customer_name: 'Riyaz' },
    footer: 'Reply STOP to unsubscribe',
    buttons: [{ type: 'URL', text: 'Track order', url: 'https://example.com/track' }],
  });
  const footerComponent = payload.components.find((c) => c.type === 'FOOTER');
  const buttonsComponent = payload.components.find((c) => c.type === 'BUTTONS');
  assert.equal(footerComponent.text, 'Reply STOP to unsubscribe');
  assert.deepEqual(buttonsComponent.buttons, [{ type: 'URL', text: 'Track order', url: 'https://example.com/track' }]);
});

test('buildTemplateCreatePayload: Authentication category builds the fixed Meta structure, ignoring any body', () => {
  const payload = buildTemplateCreatePayload({
    name: 'otp_login',
    category: 'Authentication',
    codeExpirationMinutes: 10,
    addSecurityDisclaimer: true,
  });
  assert.equal(payload.category, 'AUTHENTICATION');
  assert.deepEqual(payload.components, [
    { type: 'BODY', add_security_recommendation: true },
    { type: 'FOOTER', code_expiration_minutes: 10 },
    { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
  ]);
});

test('messageTemplateCreateSchema: Authentication rejects a supplied body/header/footer/buttons', () => {
  const result = messageTemplateCreateSchema.safeParse({
    name: 'otp_login',
    category: 'Authentication',
    body: 'Your code is {{otp_code}}.',
  });
  assert.equal(result.success, false);
});

test('messageTemplateCreateSchema: Utility with no body is rejected', () => {
  const result = messageTemplateCreateSchema.safeParse({ name: 'x', category: 'Utility' });
  assert.equal(result.success, false);
});

test('messageTemplateCreateSchema: IMAGE/VIDEO/DOCUMENT header types are accepted — the file requirement is enforced in routes/templates.js, not this schema', () => {
  for (const type of ['IMAGE', 'VIDEO', 'DOCUMENT']) {
    const result = messageTemplateCreateSchema.safeParse({
      name: 'x',
      category: 'Utility',
      body: 'Hi {{customer_name}}, your order has shipped.',
      bodyParamExamples: { customer_name: 'Riyaz' },
      header: { type },
    });
    assert.equal(result.success, true, `expected ${type} header to parse`);
  }
});

test('messageTemplateCreateSchema: an unrecognized header type is still rejected', () => {
  const result = messageTemplateCreateSchema.safeParse({
    name: 'x',
    category: 'Utility',
    body: 'Hi {{customer_name}}, your order has shipped.',
    bodyParamExamples: { customer_name: 'Riyaz' },
    header: { type: 'STICKER' },
  });
  assert.equal(result.success, false);
});

test('messageTemplateCreateSchema: more than 2 URL buttons is rejected', () => {
  const result = messageTemplateCreateSchema.safeParse({
    name: 'x',
    category: 'Utility',
    body: 'Hi {{customer_name}}, your order has shipped.',
    bodyParamExamples: { customer_name: 'Riyaz' },
    buttons: [
      { type: 'URL', text: 'a', url: 'https://example.com/1' },
      { type: 'URL', text: 'b', url: 'https://example.com/2' },
      { type: 'URL', text: 'c', url: 'https://example.com/3' },
    ],
  });
  assert.equal(result.success, false);
});

test('messageTemplateCreateSchema: a numbered-param body still parses at the schema layer (rejected later by validateTemplateText, not here — see routes/templates.js)', () => {
  // Regression guard for the bug this exact test file's PR fixed: the
  // schema must NOT try to judge param validity itself (it can't yet tell
  // {{1}} from a real name) or reject with a confusing "sample value
  // required for: 1" instead of the correct "numbered parameters" error.
  const result = messageTemplateCreateSchema.safeParse({
    name: 'x',
    category: 'Utility',
    body: 'Hi {{1}}, your order has shipped.',
  });
  assert.equal(result.success, true);
});

test('buildNamedBodyComponents: empty/no values -> empty array, matches sendTemplateMessage default', () => {
  assert.deepEqual(buildNamedBodyComponents({}), []);
  assert.deepEqual(buildNamedBodyComponents(undefined), []);
});
