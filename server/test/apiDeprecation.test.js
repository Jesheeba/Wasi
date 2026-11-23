// wasi-master-plan.md §8.6's deprecation-header mechanism. Pure middleware,
// no DB, no app wiring needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deprecated } = require('../src/middleware/apiDeprecation');

function mockRes() {
  const headers = {};
  return { headers, set: (k, v) => { headers[k] = v; } };
}

test('deprecated() sets the deprecation + sunset headers and calls next()', () => {
  const mw = deprecated({ sunset: '2027-03-01', info: 'Use GET /api/v1/new-endpoint instead.' });
  const res = mockRes();
  let nextCalled = false;
  mw({}, res, () => { nextCalled = true; });
  assert.ok(nextCalled);
  assert.equal(res.headers['X-Wasi-API-Deprecation'], 'true');
  assert.equal(res.headers['X-Wasi-API-Deprecation-Sunset'], '2027-03-01');
  assert.equal(res.headers['X-Wasi-API-Deprecation-Info'], 'Use GET /api/v1/new-endpoint instead.');
});

test('deprecated() omits the info header when none is given', () => {
  const mw = deprecated({ sunset: '2027-03-01' });
  const res = mockRes();
  mw({}, res, () => {});
  assert.equal(res.headers['X-Wasi-API-Deprecation'], 'true');
  assert.equal('X-Wasi-API-Deprecation-Info' in res.headers, false);
});

test('deprecated() throws at setup time without a sunset date, not at request time', () => {
  assert.throws(() => deprecated({}), /sunset date/);
  assert.throws(() => deprecated(), /sunset date/);
});
