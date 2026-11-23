// Admin role enforcement (CLAUDE.md Known Gaps: "admin_users.role is validated
// on create but no route or middleware ever checks it"). Two kinds of test,
// both DB-free: (1) requireAdminRole is pure request/response logic, tested
// directly; (2) a source-level guard on the high-blast-radius routes, so a
// future edit that drops the role check without touching this file fails
// loudly instead of silently reopening the gap.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const { requireAdminRole } = require('../src/middleware/requireAdminAuth');

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('requireAdminRole calls next() for an allowed role', () => {
  const mw = requireAdminRole('super_admin', 'support');
  const req = { adminRole: 'support' };
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled);
  assert.equal(res.statusCode, null);
});

test('requireAdminRole returns 403 for a disallowed role, never calling next()', () => {
  const mw = requireAdminRole('super_admin', 'platform_admin');
  const req = { adminRole: 'billing' };
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /does not have access/);
});

test('requireAdminRole rejects a missing/undefined role (e.g. a malformed token)', () => {
  const mw = requireAdminRole('support');
  const req = {};
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

// Source-level guard: every route listed here grants durable access, mints
// or rotates a credential/secret, or can destroy data - the "full roles
// only" tier agreed with the account owner. Each must carry a role-check
// middleware (fullOnly/billingOrFull, not bare asyncHandler) directly on its
// router line.
const ADMIN_JS = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');
const CLIENTS_JS = fs.readFileSync(path.join(__dirname, '../src/routes/clients.js'), 'utf8');
const CONVERSATION_PRICING_JS = fs.readFileSync(path.join(__dirname, '../src/routes/conversationPricing.js'), 'utf8');

function assertRouteGated(source, routeLineFragment, label) {
  const lines = source.split('\n');
  const line = lines.find((l) => l.includes(routeLineFragment));
  assert.ok(line, `route line not found: ${routeLineFragment}`);
  assert.doesNotMatch(
    line,
    /'\s*,\s*asyncHandler\(/,
    `${label} has no role-check middleware before asyncHandler - it is reachable by ANY admin role: ${line.trim()}`,
  );
}

test('admin.js: admin-user management requires the full-access roles', () => {
  assertRouteGated(ADMIN_JS, "router.post('/admin-users'", 'POST /admin-users');
});

test('admin.js: API key minting/revocation requires the full-access roles', () => {
  assertRouteGated(ADMIN_JS, "router.post('/api-keys'", 'POST /api-keys');
  assertRouteGated(ADMIN_JS, "router.post('/api-keys/:id/revoke'", 'POST /api-keys/:id/revoke');
  assertRouteGated(ADMIN_JS, "router.delete('/api-keys/:id'", 'DELETE /api-keys/:id');
});

test('admin.js: webhook secret regeneration requires the full-access roles', () => {
  assertRouteGated(ADMIN_JS, "router.post('/clients/:id/hub-forward/regenerate-secret'", 'POST .../hub-forward/regenerate-secret');
});

test('admin.js: data-deletion completion, test alerts, and the Meta library refresh require the full-access roles', () => {
  assertRouteGated(ADMIN_JS, "router.post('/data-deletion-requests/:code/complete'", 'POST /data-deletion-requests/:code/complete');
  assertRouteGated(ADMIN_JS, "router.post('/alerts/test'", 'POST /alerts/test');
  assertRouteGated(ADMIN_JS, "router.post('/template-library/meta/refresh'", 'POST /template-library/meta/refresh');
});

test('admin.js: billing routes require billing or full-access roles', () => {
  assertRouteGated(ADMIN_JS, "router.get('/billing/overview'", 'GET /billing/overview');
  assertRouteGated(ADMIN_JS, "router.post('/payment-notifications/send-reminders'", 'POST /payment-notifications/send-reminders');
});

test('clients.js: password reset and client deletion require the full-access roles', () => {
  assertRouteGated(CLIENTS_JS, "router.post('/:id/reset-password'", 'POST /:id/reset-password');
  assertRouteGated(CLIENTS_JS, "router.delete('/:id'", 'DELETE /:id');
});

test('conversationPricing.js: writing a billing rate requires billing or full-access roles', () => {
  assertRouteGated(CONVERSATION_PRICING_JS, "router.post('/'", 'POST /');
  assertRouteGated(CONVERSATION_PRICING_JS, "router.delete('/:id'", 'DELETE /:id');
});
