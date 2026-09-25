// Password reset item 3 — session invalidation. Stubs only, per explicit
// instruction for this task: nothing is written to the shared database (this
// project has no separate dev DB — see CLAUDE.md/dbSafety.js). `pool.query`
// is monkey-patched to return canned rows; no HTTP server, no createApp(),
// no real registration/login round trip. Requiring '../src/db/pool' only
// constructs a `pg.Pool` object (lazy-connect) — no network I/O happens
// unless something actually calls .query(), which this file never lets
// reach the real driver.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { pool } = require('../src/db/pool');
const { requireClientAuth } = require('../src/middleware/requireClientAuth');
const { requireAdminAuth } = require('../src/middleware/requireAdminAuth');
const { requireClientOrTeamAuth } = require('../src/middleware/requireClientOrTeamAuth');
const {
  signClientToken, signAdminToken, signTeamMemberToken,
} = require('../src/utils/auth');

// Swaps pool.query for a stub that answers `select token_version from <table>
// where id = $1 [and client_id = $2]` with a fixed version, restoring the
// real function afterward. Asserts the query actually targeted the expected
// table, so a middleware change that queries the wrong table fails loudly
// here instead of silently passing.
function stubTokenVersion(expectedTable, version) {
  const original = pool.query;
  const calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    assert.match(sql, new RegExp(`from ${expectedTable}\\b`), `expected a query against ${expectedTable}, got: ${sql}`);
    return { rows: version === undefined ? [] : [{ token_version: version }] };
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
    Promise.resolve(middleware(req, res, next)).then((maybeResult) => {
      // If the middleware itself already resolved res (rejected the
      // request) without ever calling next(), resolve with false instead of
      // hanging — no error was thrown, there's just nothing left to await.
      if (!nextCalled) resolve(false);
    }).catch(reject);
  });
}

// --- Client ---

test('client: signClientToken embeds token_version; a matching version passes requireClientAuth', async () => {
  const token = signClientToken({ id: 'client-1', token_version: 3 });
  const decoded = jwt.decode(token);
  assert.equal(decoded.tokenVersion, 3);

  const stub = stubTokenVersion('clients', 3);
  try {
    const { req, res } = fakeReqRes(token);
    const passed = await runMiddleware(requireClientAuth, req, res);
    assert.equal(passed, true);
    assert.equal(req.clientId, 'client-1');
  } finally {
    stub.restore();
  }
});

test('client: a token issued before a password reset (old tokenVersion) is rejected after the bump — same shape as an expired token', async () => {
  // Token minted while token_version was 0 (before the reset).
  const oldToken = signClientToken({ id: 'client-1', token_version: 0 });

  // The reset already ran server-side — clients.token_version is now 1.
  const stub = stubTokenVersion('clients', 1);
  try {
    const { req, res } = fakeReqRes(oldToken);
    const passed = await runMiddleware(requireClientAuth, req, res);
    assert.equal(passed, false);
    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { error: 'Invalid or expired token' });
  } finally {
    stub.restore();
  }
});

test('client: a token issued after the reset (fresh login, new tokenVersion) is accepted', async () => {
  const newToken = signClientToken({ id: 'client-1', token_version: 1 });

  const stub = stubTokenVersion('clients', 1);
  try {
    const { req, res } = fakeReqRes(newToken);
    const passed = await runMiddleware(requireClientAuth, req, res);
    assert.equal(passed, true);
    assert.equal(req.clientId, 'client-1');
  } finally {
    stub.restore();
  }
});

test('client: a token predating this feature (no tokenVersion claim at all) is treated as version 0 — existing tokens survive the deploy', async () => {
  const legacyToken = jwt.sign({ type: 'client', sub: 'client-1' }, process.env.JWT_SECRET, { expiresIn: '7d' });

  const stub = stubTokenVersion('clients', 0);
  try {
    const { req, res } = fakeReqRes(legacyToken);
    const passed = await runMiddleware(requireClientAuth, req, res);
    assert.equal(passed, true, 'a claim-less token must match a never-bumped (default 0) row');
  } finally {
    stub.restore();
  }
});

test('client: a client row that no longer exists is rejected, not treated as version-0-matches-version-0', async () => {
  const token = signClientToken({ id: 'deleted-client', token_version: 0 });
  const stub = stubTokenVersion('clients', undefined); // no row found
  try {
    const { req, res } = fakeReqRes(token);
    const passed = await runMiddleware(requireClientAuth, req, res);
    assert.equal(passed, false);
    assert.equal(res._status, 401);
  } finally {
    stub.restore();
  }
});

// --- Admin ---

test('admin: a token issued before a password reset is rejected after it; a token issued after is accepted', async () => {
  const oldToken = signAdminToken({ id: 'admin-1', role: 'support', token_version: 0 });
  const newToken = signAdminToken({ id: 'admin-1', role: 'support', token_version: 1 });
  const middleware = requireAdminAuth();

  let stub = stubTokenVersion('admin_users', 1); // reset already happened
  try {
    const { req, res } = fakeReqRes(oldToken);
    const passed = await runMiddleware(middleware, req, res);
    assert.equal(passed, false);
    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { error: 'Invalid or expired token' });
  } finally {
    stub.restore();
  }

  stub = stubTokenVersion('admin_users', 1);
  try {
    const { req, res } = fakeReqRes(newToken);
    const passed = await runMiddleware(middleware, req, res);
    assert.equal(passed, true);
    assert.equal(req.adminId, 'admin-1');
  } finally {
    stub.restore();
  }
});

// --- Team member (requireClientOrTeamAuth) ---

test('team_member: token version is checked against team_members, scoped to the token\'s own claimed client_id', async () => {
  const token = signTeamMemberToken({ id: 'tm-1', client_id: 'client-9', role: 'Agent', token_version: 2 });
  const stub = stubTokenVersion('team_members', 2);
  try {
    const { req, res } = fakeReqRes(token);
    const passed = await runMiddleware(requireClientOrTeamAuth, req, res);
    assert.equal(passed, true);
    assert.equal(req.clientId, 'client-9');
    assert.equal(req.actorType, 'team_member');
    assert.deepEqual(stub.calls[0].params, ['tm-1', 'client-9']);
  } finally {
    stub.restore();
  }
});

test('team_member: a stale token (bumped elsewhere) is rejected the same way an owner token would be', async () => {
  const staleToken = signTeamMemberToken({ id: 'tm-1', client_id: 'client-9', role: 'Agent', token_version: 0 });
  const stub = stubTokenVersion('team_members', 1);
  try {
    const { req, res } = fakeReqRes(staleToken);
    const passed = await runMiddleware(requireClientOrTeamAuth, req, res);
    assert.equal(passed, false);
    assert.equal(res._status, 401);
  } finally {
    stub.restore();
  }
});

// --- Repo bump functions issue the right SQL ---

test('clientsRepo.bumpTokenVersion increments clients.token_version for the given id', async () => {
  const clientsRepo = require('../src/repositories/clientsRepo');
  const original = pool.query;
  let captured = null;
  pool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await clientsRepo.bumpTokenVersion(pool, 'client-1');
    assert.match(captured.sql, /update clients set token_version = token_version \+ 1 where id = \$1/);
    assert.deepEqual(captured.params, ['client-1']);
  } finally {
    pool.query = original;
  }
});

test('adminUsersRepo.bumpTokenVersion increments admin_users.token_version for the given id', async () => {
  const adminUsersRepo = require('../src/repositories/adminUsersRepo');
  const original = pool.query;
  let captured = null;
  pool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await adminUsersRepo.bumpTokenVersion('admin-1');
    assert.match(captured.sql, /update admin_users set token_version = token_version \+ 1 where id = \$1/);
    assert.deepEqual(captured.params, ['admin-1']);
  } finally {
    pool.query = original;
  }
});
