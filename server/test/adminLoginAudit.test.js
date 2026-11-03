// Admin login audit logging. Stubs only: adminUsersRepo and auditLogRepo are
// monkey-patched on their required module objects, so no database is touched
// (the repo's DB guard refuses test-context connections anyway).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const adminUsersRepo = require('../src/repositories/adminUsersRepo');
const auditLogRepo = require('../src/repositories/auditLogRepo');
const authTokensRepo = require('../src/repositories/authTokensRepo');

const REAL = {
  findByEmail: adminUsersRepo.findByEmail,
  updatePassword: adminUsersRepo.updatePassword,
  bumpTokenVersion: adminUsersRepo.bumpTokenVersion,
  record: auditLogRepo.record,
  create: authTokensRepo.create,
  consume: authTokensRepo.consume,
};

const GOOD_PASSWORD = 'correct-horse-battery-staple-1';
let server;
let baseUrl;
let audit;
let adminRow;
let emailCounter = 0;

before(async () => {
  adminRow = {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Test Admin',
    email: 'login-audit@example.test',
    role: 'support',
    token_version: 0,
    password_hash: await bcrypt.hash(GOOD_PASSWORD, 4),
  };
  const adminAuthRouter = require('../src/routes/adminAuth');
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/admin/auth', adminAuthRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  Object.assign(adminUsersRepo, { findByEmail: REAL.findByEmail, updatePassword: REAL.updatePassword, bumpTokenVersion: REAL.bumpTokenVersion });
  auditLogRepo.record = REAL.record;
  Object.assign(authTokensRepo, { create: REAL.create, consume: REAL.consume });
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  audit = [];
  // Distinct email per test: adminLoginLimiter is keyed on IP+email.
  emailCounter += 1;
  adminRow.email = `login-audit-${emailCounter}@example.test`;
  adminUsersRepo.findByEmail = async (email) => (email === adminRow.email ? adminRow : null);
  adminUsersRepo.updatePassword = async () => {};
  adminUsersRepo.bumpTokenVersion = async () => {};
  auditLogRepo.record = async (row) => { audit.push(row); };
});

function post(path, body, headers = {}) {
  return fetch(`${baseUrl}/api/admin/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('successful login records admin_login_succeeded with the proxied client IP', async () => {
  const res = await post('/login', { email: adminRow.email, password: GOOD_PASSWORD }, { 'x-forwarded-for': '203.0.113.7' });
  assert.equal(res.status, 200);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'admin_login_succeeded');
  assert.equal(audit[0].actor_id, adminRow.id);
  assert.equal(audit[0].actor_ip, '203.0.113.7');
  assert.equal(audit[0].target, adminRow.email);
});

test('wrong password records admin_login_failed and never the password', async () => {
  const res = await post('/login', { email: adminRow.email, password: 'not-the-password-123' }, { 'x-forwarded-for': '198.51.100.9' });
  assert.equal(res.status, 401);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'admin_login_failed');
  assert.equal(audit[0].actor_id, adminRow.id);
  assert.equal(audit[0].actor_ip, '198.51.100.9');
  assert.ok(!JSON.stringify(audit[0]).includes('not-the-password-123'));
});

test('unknown email records admin_login_failed with a null actor', async () => {
  const res = await post('/login', { email: 'nobody-here@example.test', password: 'whatever-password-1' }, { 'x-forwarded-for': '198.51.100.10' });
  assert.equal(res.status, 401);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'admin_login_failed');
  assert.equal(audit[0].actor_id, null);
  assert.match(audit[0].target, /unknown email/);
});

test('a failing audit write never blocks or breaks a login', async () => {
  auditLogRepo.record = async () => { throw new Error('db down'); };
  const res = await post('/login', { email: adminRow.email, password: GOOD_PASSWORD });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).token);
});

test('password reset request and completion are recorded', async () => {
  authTokensRepo.create = async () => 'tok';
  authTokensRepo.consume = async () => ({ subject_type: 'admin', subject_id: adminRow.id });
  // adminAuth.js destructures sendEmail at require time so it can't be stubbed
  // here; with RESEND_API_KEY unset it degrades to a console line and sends nothing.
  assert.ok(!process.env.RESEND_API_KEY, 'refusing to run: a real email could be sent');
  await post('/forgot-password', { email: adminRow.email }, { 'x-forwarded-for': '203.0.113.20' });
  await post('/reset-password', { token: 'tok', password: 'a-brand-new-password-1' }, { 'x-forwarded-for': '203.0.113.20' });
  const actions = audit.map((a) => a.action);
  assert.deepEqual(actions, ['admin_password_reset_requested', 'admin_password_reset_completed']);
  assert.ok(audit.every((a) => a.actor_ip === '203.0.113.20'));
});
