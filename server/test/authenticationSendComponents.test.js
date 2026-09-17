// Hub API Authentication (OTP) template sends — routes/apiV1Messages.js used
// to run every template through buildNamedBodyComponents, which (a) tags the
// body parameter with a parameter_name an Authentication template doesn't
// have and (b) never fills the copy-code button, so Meta rejected every OTP
// send. First caller: TNPSC Mentor's signup OTP (template `signup_otp2`).
// Pure payload-shape test — no DB, no Meta.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAuthenticationSendComponents } = require('../src/utils/metaClient');

test('puts the code in the body as a positional parameter AND in the copy-code button', () => {
  assert.deepEqual(buildAuthenticationSendComponents('482913'), [
    { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] },
  ]);
});

test('body parameter carries no parameter_name', () => {
  const [body] = buildAuthenticationSendComponents('000123');
  assert.equal('parameter_name' in body.parameters[0], false);
});

test('keeps leading zeros by sending the code as a string', () => {
  const components = buildAuthenticationSendComponents('004200');
  assert.equal(components[0].parameters[0].text, '004200');
  assert.equal(components[1].parameters[0].text, '004200');
});
