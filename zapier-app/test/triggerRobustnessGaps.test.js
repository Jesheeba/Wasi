// Independent QA pass (Phase 4) — regression tests for
// triggers/newMessageReceived.js's perform() against malformed/unexpected
// bundle shapes. No backend/DB needed — exercises the real Zapier app code
// through zapier-platform-core's own test harness only.
//
// Originally found two real gaps (a raw TypeError crash on an empty bundle,
// and a non-object [null] trigger result when cleanedRequest.data was
// absent) — both fixed the same session, alongside the separate HMAC
// signature-verification fix (see zapier-app/test/app.test.js for the
// signature-specific tests against a real backend). perform() now checks
// the signature FIRST, before ever touching cleanedRequest.data, so most of
// the malformed-bundle cases below now fail fast with a clear, controlled
// "no verifiable signature" error rather than the old raw TypeError —
// stricter than the original ask, since a request with no way to prove it's
// really from Wasi shouldn't be processed at all, malformed or not.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const zapier = require('zapier-platform-core');

const App = require('../index');
const appTester = zapier.createAppTester(App);

function signedBundle(payload) {
  const content = JSON.stringify(payload);
  const secret = 'test-suite-trigger-robustness-secret';
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(content).digest('hex');
  return {
    subscribeData: { secret },
    cleanedRequest: payload,
    rawRequest: { headers: { 'x-wasi-signature-256': signature }, content },
  };
}

test('sanity: perform() unwraps a well-formed, correctly-signed { data } envelope correctly', async () => {
  const results = await appTester(
    App.triggers.new_message_received.operation.perform,
    signedBundle({ event: 'message.received', data: { message_id: '1', message: { body: 'hi' } } })
  );
  assert.deepEqual(results, [{ message_id: '1', message: { body: 'hi' } }]);
});

test('FIXED: perform() no longer throws a raw TypeError on a completely empty bundle — rejects with a clear, controlled error', async () => {
  await assert.rejects(
    () => appTester(App.triggers.new_message_received.operation.perform, {}),
    /no verifiable signature/i,
    'FIX PROOF: an empty bundle (no subscribeData/rawRequest at all) now fails signature verification with a ' +
    'clear message instead of crashing on bundle.cleanedRequest.data with a raw "Cannot read properties of undefined" TypeError.'
  );
});

test('FIXED: a correctly-signed request with no cleanedRequest.data returns [], not a non-object [null] trigger result', async () => {
  const bundle = signedBundle({ event: 'message.received' }); // no .data field at all
  const results = await appTester(App.triggers.new_message_received.operation.perform, bundle);
  assert.deepEqual(results, [], 'FIX PROOF: perform() now returns an empty array instead of [null], which fails ' +
    'zapier-platform-core\'s own "triggerIsObject" trigger-result schema check.');
});

test('FIXED: a request with a completely missing signature header is rejected, not silently processed', async () => {
  await assert.rejects(
    () => appTester(App.triggers.new_message_received.operation.perform, {
      subscribeData: { secret: 'some-secret' },
      cleanedRequest: { event: 'message.received', data: { message: { body: 'forged' } } },
      rawRequest: { headers: {}, content: '{}' },
    }),
    /no verifiable signature/i
  );
});

test('FIXED: a request with a WRONG signature is rejected, not silently processed', async () => {
  const payload = { event: 'message.received', data: { message: { body: 'forged' } } };
  await assert.rejects(
    () => appTester(App.triggers.new_message_received.operation.perform, {
      subscribeData: { secret: 'the-real-secret' },
      cleanedRequest: payload,
      rawRequest: { headers: { 'x-wasi-signature-256': 'sha256=totally_wrong' }, content: JSON.stringify(payload) },
    }),
    /failed signature verification/i
  );
});
