// build-docs/features/client-suspension-paywall.md - acceptance criteria.
// Stubs only, same discipline as sessionInvalidation.test.js: `pool.query`
// is monkey-patched to return canned rows; no HTTP server, no createApp(),
// nothing written to the shared database (this project has no separate dev
// DB - see CLAUDE.md/dbSafety.js).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../src/db/pool');
const { requireClientAuth } = require('../src/middleware/requireClientAuth');
const { requireClientOrTeamAuth } = require('../src/middleware/requireClientOrTeamAuth');
const { requireActiveSubscription } = require('../src/middleware/requireActiveSubscription');
const { signClientToken, signTeamMemberToken } = require('../src/utils/auth');

// Same shape as sessionInvalidation.test.js's stubTokenVersion, extended
// with a `status` (owner) / `client_status` (team member) column so both
// auth middlewares' now-widened select can be answered.
function stubClientRow(expectedTable, { tokenVersion, status } = {}) {
  const original = pool.query;
  const calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    assert.match(sql, new RegExp(`from ${expectedTable}\\b`), `expected a query against ${expectedTable}, got: ${sql}`);
    if (tokenVersion === undefined) return { rows: [] };
    return { rows: [{ token_version: tokenVersion, status, client_status: status }] };
  };
  return { calls, restore: () => { pool.query = original; } };
}

function fakeReqRes(token) {
  const req = { get: (name) => (name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined) };
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return { req, res };
}

function runMiddleware(middleware, req, res) {
  return new Promise((resolve, reject) => {
    let nextCalled = false;
    const next = (err) => {
      if (err) return reject(err);
      nextCalled = true;
      resolve(nextCalled);
    };
    Promise.resolve(middleware(req, res, next)).then(() => {
      if (!nextCalled) resolve(false);
    }).catch(reject);
  });
}

// --- requireClientAuth: widened select exposes req.clientStatus, never blocks itself ---

test('requireClientAuth: an active owner passes, req.clientStatus is "active"', async () => {
  const token = signClientToken({ id: 'client-1', token_version: 0 });
  const stub = stubClientRow('clients', { tokenVersion: 0, status: 'active' });
  try {
    const { req, res } = fakeReqRes(token);
    const passed = await runMiddleware(requireClientAuth, req, res);
    assert.equal(passed, true);
    assert.equal(req.clientStatus, 'active');
  } finally {
    stub.restore();
  }
});

test('requireClientAuth: a suspended owner STILL passes here - this middleware never blocks on status (billing/auth-me rely on exactly that)', async () => {
  const token = signClientToken({ id: 'client-1', token_version: 0 });
  const stub = stubClientRow('clients', { tokenVersion: 0, status: 'suspended' });
  try {
    const { req, res } = fakeReqRes(token);
    const passed = await runMiddleware(requireClientAuth, req, res);
    assert.equal(passed, true);
    assert.equal(req.clientStatus, 'suspended');
  } finally {
    stub.restore();
  }
});

// --- requireClientOrTeamAuth: both branches expose req.clientStatus ---

test('requireClientOrTeamAuth: owner branch sets req.clientStatus from clients.status', async () => {
  const token = signClientToken({ id: 'client-1', token_version: 0 });
  const stub = stubClientRow('clients', { tokenVersion: 0, status: 'suspended' });
  try {
    const { req, res } = fakeReqRes(token);
    const passed = await runMiddleware(requireClientOrTeamAuth, req, res);
    assert.equal(passed, true);
    assert.equal(req.clientStatus, 'suspended');
  } finally {
    stub.restore();
  }
});

test('requireClientOrTeamAuth: team_member branch sets req.clientStatus from the OWNING CLIENT (joined), not the team member', async () => {
  const token = signTeamMemberToken({ id: 'tm-1', client_id: 'client-9', role: 'Agent', token_version: 2 });
  const stub = stubClientRow('team_members', { tokenVersion: 2, status: 'suspended' });
  try {
    const { req, res } = fakeReqRes(token);
    const passed = await runMiddleware(requireClientOrTeamAuth, req, res);
    assert.equal(passed, true);
    assert.equal(req.clientId, 'client-9');
    assert.equal(req.clientStatus, 'suspended', 'a team member has no status of their own - must reflect the owning client');
  } finally {
    stub.restore();
  }
});

// --- requireActiveSubscription: the actual gate ---

test('requireActiveSubscription: active passes through', async () => {
  const { req, res } = fakeReqRes();
  req.clientStatus = 'active';
  const passed = await runMiddleware(requireActiveSubscription, req, res);
  assert.equal(passed, true);
});

// Changed 2026-11-24 by owner decision (build-docs/features/unpaid-signup-block.md):
// an account that signed up but never paid is blocked too. It was left open
// earlier only because real clients were stuck in pending_setup by a status
// bug; none are now (every working client is active or payment_confirmed).
test('requireActiveSubscription: pending_setup (signed up, never paid) is blocked with 402 payment_required', async () => {
  const { req, res } = fakeReqRes();
  req.clientStatus = 'pending_setup';
  const passed = await runMiddleware(requireActiveSubscription, req, res);
  assert.equal(passed, false);
  assert.equal(res._status, 402);
  assert.deepEqual(res._body, { error: 'payment_required' });
});

test('requireActiveSubscription: payment_confirmed (paid, WhatsApp not connected yet) passes through', async () => {
  const { req, res } = fakeReqRes();
  req.clientStatus = 'payment_confirmed';
  const passed = await runMiddleware(requireActiveSubscription, req, res);
  assert.equal(passed, true);
});

test('requireActiveSubscription: suspended is blocked with 402 subscription_suspended', async () => {
  const { req, res } = fakeReqRes();
  req.clientStatus = 'suspended';
  const passed = await runMiddleware(requireActiveSubscription, req, res);
  assert.equal(passed, false);
  assert.equal(res._status, 402);
  assert.deepEqual(res._body, { error: 'subscription_suspended' });
});
