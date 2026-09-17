const test = require('node:test');
const assert = require('node:assert/strict');
const { describeMessageFailure, MESSAGE_ERROR_MESSAGES } = require('../src/utils/metaMessageErrorMessages');

test('a known Meta error code returns its mapped plain-language message', () => {
  const msg = describeMessageFailure({ metaErrorCode: 131047, errorReason: 'Re-engagement message' });
  assert.equal(msg, MESSAGE_ERROR_MESSAGES[131047]);
  assert.match(msg, /24 hours/);
});

test('an unknown Meta error code falls back to the raw stored reason', () => {
  const msg = describeMessageFailure({ metaErrorCode: 999999, errorReason: 'Some brand-new Meta error text' });
  assert.equal(msg, 'Some brand-new Meta error text');
});

test('no Meta error code (a pre-send failure) falls back to the raw stored reason', () => {
  const msg = describeMessageFailure({ metaErrorCode: null, errorReason: 'This template has parameters with no value source' });
  assert.equal(msg, 'This template has parameters with no value source');
});

test('neither a code nor a reason falls back to a generic message', () => {
  const msg = describeMessageFailure({ metaErrorCode: null, errorReason: null });
  assert.equal(msg, 'Message could not be delivered.');
});

test('describeMessageFailure() with no argument at all does not throw', () => {
  const msg = describeMessageFailure();
  assert.equal(msg, 'Message could not be delivered.');
});
