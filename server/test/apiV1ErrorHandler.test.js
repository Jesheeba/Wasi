// Pure-function tests for middleware/apiV1ErrorHandler.js — deliberately
// doesn't import pool.js/app.js (same reasoning as test/dbSafety.test.js:
// no DB/server needed to verify this), so it runs with no DATABASE_URL
// guard involved at all.
//
// Covers the generic catch-all branches (Postgres 23505/23503, an uncaught
// error, and the 404 handler) that apiV1.test.js/apiV1Reads.test.js/
// apiV1ErrorShape.test.js can't reach through a real HTTP request without
// contriving an actual constraint violation — Hub API v1's two write
// endpoints (POST /api/v1/messages, POST /api/v1/templates) have no
// realistically-reachable unique/FK constraint a valid request could hit
// (messageTemplatesRepo.create has no unique(client_id, name) constraint;
// contactsRepo.upsertByPhone is an upsert, not a raw insert). A mock
// req/res pair exercises the same code these branches would run in
// production, without needing to force one of those in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { z, ZodError } = require('zod');
const { apiV1NotFoundHandler, apiV1ErrorHandler } = require('../src/middleware/apiV1ErrorHandler');

// Minimal Express-response double: captures the status code and JSON body
// exactly the way res.status(n).json(body) would, nothing more.
function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

test('apiV1NotFoundHandler: 404, { error: { code: not_found, message } }', () => {
  const res = fakeRes();
  apiV1NotFoundHandler({}, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(Object.keys(res.body), ['error']);
  assert.equal(res.body.error.code, 'not_found');
  assert.equal(typeof res.body.error.message, 'string');
});

test('apiV1ErrorHandler: a ZodError normalizes to 400, code validation_failed, readable details', () => {
  const schema = z.object({ limit: z.number().min(1) });
  let zodErr;
  try {
    schema.parse({ limit: 0 });
  } catch (err) {
    zodErr = err;
  }
  assert.ok(zodErr instanceof ZodError);

  const res = fakeRes();
  apiV1ErrorHandler(zodErr, {}, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'validation_failed');
  assert.ok(Array.isArray(res.body.error.details) && res.body.error.details.length > 0);
  assert.match(res.body.error.details[0], /limit/);
});

test('apiV1ErrorHandler: a Postgres unique-violation (23505) normalizes to 409, code conflict', () => {
  const pgErr = Object.assign(new Error('duplicate key value'), { code: '23505', detail: 'Key (x)=(y) already exists.' });
  const res = fakeRes();
  apiV1ErrorHandler(pgErr, {}, res, () => {});
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'conflict');
  assert.equal(res.body.error.detail, pgErr.detail);
});

test('apiV1ErrorHandler: a Postgres FK-violation (23503) normalizes to 400, code invalid_reference', () => {
  const pgErr = Object.assign(new Error('violates foreign key constraint'), { code: '23503', detail: 'Key (client_id)=(...) is not present in table "clients".' });
  const res = fakeRes();
  apiV1ErrorHandler(pgErr, {}, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'invalid_reference');
  assert.equal(res.body.error.detail, pgErr.detail);
});

test('apiV1ErrorHandler: an uncaught error normalizes to 500, code internal_error, no leaked error.message/stack', () => {
  const res = fakeRes();
  const originalConsoleError = console.error;
  console.error = () => {}; // this test deliberately triggers the logged branch; keep test output clean
  try {
    apiV1ErrorHandler(new Error('some internal detail that must never reach the caller'), {}, res, () => {});
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(res.statusCode, 500);
  assert.deepEqual(Object.keys(res.body), ['error']);
  assert.equal(res.body.error.code, 'internal_error');
  assert.equal(res.body.error.message, 'Internal server error.');
  assert.doesNotMatch(JSON.stringify(res.body), /some internal detail/);
});
