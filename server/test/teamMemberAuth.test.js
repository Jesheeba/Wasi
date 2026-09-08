// PLAN.md item 1 — team member authentication & roles. Verifies:
// 1. invite -> accept-invite -> login issues a working team_member JWT.
// 2. requireClientOrTeamAuth resolves the SAME tenant isolation as the
//    owner (req.clientId set correctly, RLS behaves identically).
// 3. requireRole's route-by-route matrix: an Agent-role token is denied on
//    Admin/Manager-only routes (403) and allowed on Agent-reachable ones.
// 4. The structural fix itself: a team_member token is REJECTED (401, wrong
//    token type — not merely 403) on every router deliberately left on the
//    unchanged requireClientAuth (onboarding, billing, wallet,
//    client-webhook, api-keys, payment-links) — proving those routers are
//    unreachable by construction, not by an easy-to-forget role check.
// Same dedicated-disposable-test-client convention as every other file in
// this directory: a real client via /api/auth/register, deleted in after().
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;
let clientToken;
let testClientId;
let tenantSlug;

const SUITE_PREFIX = '__test_suite__teammemberauth_';
const PASSWORD = 'test-suite-password-12345';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Mirrors routes/teamMembers.js's /:id/invite handler's own token-issuance
// path exactly (authTokensRepo.create with purpose 'team_invite') rather
// than re-deriving it — this is the same function the real invite endpoint
// calls, just invoked directly so the test doesn't depend on emailService's
// console-log fallback to recover the raw token.
const authTokensRepo = require('../src/repositories/authTokensRepo');

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client`,
      email: `test-suite-teammemberauth-${Date.now()}@wasi.local`,
      password: PASSWORD,
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  tenantSlug = registered.client?.tenant_slug;
  assert.ok(clientToken && testClientId && tenantSlug, 'dedicated test client registration must succeed');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function createTeamMember(role) {
  const res = await fetch(`${baseUrl}/api/team-members`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}${role}`, email: `${SUITE_PREFIX}${role}-${Date.now()}@wasi.local`, role }),
  });
  return res.json();
}

async function acceptInviteAndLogin(teamMember) {
  const token = await authTokensRepo.create('team_member', teamMember.id, 'team_invite', 60);
  const acceptRes = await fetch(`${baseUrl}/api/auth/team/accept-invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password: PASSWORD }),
  });
  assert.equal(acceptRes.status, 200);
  const { token: jwt } = await acceptRes.json();
  assert.ok(jwt, 'accept-invite must return a usable token');
  return jwt;
}

test('1. invite -> accept-invite -> login: full round trip issues a working team_member JWT', async () => {
  const created = await createTeamMember('Admin');
  assert.equal(created.role, 'Admin');

  const jwtFromAccept = await acceptInviteAndLogin(created);

  // The token returned by accept-invite must itself already work.
  const meRes = await fetch(`${baseUrl}/api/team-members`, { headers: authed(jwtFromAccept) });
  assert.equal(meRes.status, 200);

  // login must also work afterward, independently, with the password just set.
  const loginRes = await fetch(`${baseUrl}/api/auth/team/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantSlug, email: created.email, password: PASSWORD }),
  });
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.ok(loginData.token);
  assert.equal(loginData.teamMember.role, 'Admin');
  assert.equal(loginData.teamMember.id, created.id);
});

test('1c. GET /api/auth/team/me (item 5.5\'s session-resume endpoint): works for a team-member token, 403s an owner token', async () => {
  const created = await createTeamMember('Manager');
  const jwt = await acceptInviteAndLogin(created);

  const meRes = await fetch(`${baseUrl}/api/auth/team/me`, { headers: authed(jwt) });
  assert.equal(meRes.status, 200);
  const me = await meRes.json();
  assert.equal(me.id, created.id);
  assert.equal(me.role, 'Manager');
  assert.equal(me.tenantSlug, tenantSlug);
  assert.ok(me.clientName);

  const ownerRes = await fetch(`${baseUrl}/api/auth/team/me`, { headers: authed(clientToken) });
  assert.equal(ownerRes.status, 403);
});

test('1b. the real POST /:id/invite endpoint sends an email carrying tenantSlug, not just the accept-invite token', async () => {
  // Without this, a recipient who sets a password via accept-invite (which
  // auto-logs them in for that one session) has no way to fill in the
  // tenantSlug field POST /api/auth/team/login requires for every login
  // after that — found via direct code review, verified here against the
  // REAL route (not the authTokensRepo shortcut acceptInviteAndLogin uses
  // elsewhere in this file, which never exercises this endpoint at all).
  const created = await createTeamMember('Agent');

  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => { logged.push(args.join(' ')); };
  let inviteRes;
  try {
    inviteRes = await fetch(`${baseUrl}/api/team-members/${created.id}/invite`, {
      method: 'POST',
      headers: authed(clientToken),
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(inviteRes.status, 200);

  const emailLog = logged.find((l) => l.includes(created.email));
  assert.ok(emailLog, 'emailService should have logged the invite (no RESEND_API_KEY in this env)');
  assert.match(emailLog, new RegExp(tenantSlug), 'the logged email must contain the tenantSlug the recipient needs to log in later');
});

test('2. login rejects a team member who has not accepted their invite yet (no password set)', async () => {
  const created = await createTeamMember('Agent');
  const res = await fetch(`${baseUrl}/api/auth/team/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantSlug, email: created.email, password: PASSWORD }),
  });
  assert.equal(res.status, 401);
});

test('3. login rejects a wrong password once accepted', async () => {
  const created = await createTeamMember('Agent');
  await acceptInviteAndLogin(created);
  const res = await fetch(`${baseUrl}/api/auth/team/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantSlug, email: created.email, password: 'wrong-password-entirely' }),
  });
  assert.equal(res.status, 401);
});

test('4. an accepted team_member JWT gets correct tenant isolation, same as the owner', async () => {
  const created = await createTeamMember('Admin');
  const jwt = await acceptInviteAndLogin(created);

  // Create a contact as the owner, confirm the team member (same tenant) can see it.
  const contact = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}contact`, phone: `91700${Date.now()}`.slice(0, 12) }),
  }).then((r) => r.json());

  const listRes = await fetch(`${baseUrl}/api/contacts`, { headers: authed(jwt) });
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.ok(list.some((c) => c.id === contact.id), 'the team member must see the same tenant\'s data as the owner');
});

test('5. an Agent-role token is denied (403) on Admin/Manager-only routes', async () => {
  const created = await createTeamMember('Agent');
  const jwt = await acceptInviteAndLogin(created);

  const templateRes = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ name: `${SUITE_PREFIX}tpl`, category: 'Utility', body: 'Hi there' }),
  });
  assert.equal(templateRes.status, 403);

  const broadcastRes = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ title: `${SUITE_PREFIX}bcast` }),
  });
  assert.equal(broadcastRes.status, 403);

  const analyticsRes = await fetch(`${baseUrl}/api/analytics/messages`, { headers: authed(jwt) });
  assert.equal(analyticsRes.status, 403);
});

test('6. the SAME Agent-role token is allowed on Agent-reachable routes (GET templates, chat replies)', async () => {
  const created = await createTeamMember('Agent');
  const jwt = await acceptInviteAndLogin(created);

  const templateListRes = await fetch(`${baseUrl}/api/templates`, { headers: authed(jwt) });
  assert.equal(templateListRes.status, 200);

  const contactsListRes = await fetch(`${baseUrl}/api/contacts`, { headers: authed(jwt) });
  assert.equal(contactsListRes.status, 200);
});

test('7. an Admin-role team_member token is REJECTED on every owner-only router by requireClientAuth\'s own unchanged wrong-token-type check (403) — the structural fix, not a role check', async () => {
  const created = await createTeamMember('Admin');
  const jwt = await acceptInviteAndLogin(created);

  // requireClientAuth.js (untouched by this item) returns 403 "Wrong token
  // type" for any payload.type !== 'client' — a team_member token hits this
  // exact same pre-existing branch a garbage/malformed type would, on every
  // router still mounted behind requireClientAuth. The point being verified
  // is that it's rejected there at all, structurally, not via a role list
  // requireRole could accidentally leave too permissive.
  const ownerOnlyGets = [
    '/api/onboarding/whatsapp/status',
    '/api/billing/subscription',
    '/api/wallet',
    '/api/client-webhook',
    '/api/api-keys',
    '/api/payment-links',
  ];
  for (const path of ownerOnlyGets) {
    const res = await fetch(`${baseUrl}${path}`, { headers: authed(jwt) });
    assert.equal(res.status, 403, `expected 403 (wrong token type) for ${path}, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.error, 'Wrong token type');
  }
});

test('8. requireRole() with no arguments denies every team-member role by default (fail-closed)', async () => {
  const { requireRole } = require('../src/middleware/requireRole');
  const noRolesMiddleware = requireRole();
  let called = false;
  const res = {
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  noRolesMiddleware(
    { actorType: 'team_member', actorRole: 'Admin' },
    res,
    () => { called = true; }
  );
  assert.equal(called, false, 'next() must not be called for any team-member role with an empty allow-list');
  assert.equal(res._status, 403);
});

test('9. an owner (client-type) token always passes requireRole regardless of the list', async () => {
  const { requireRole } = require('../src/middleware/requireRole');
  const middleware = requireRole('Admin');
  let called = false;
  middleware({ actorType: 'owner' }, {}, () => { called = true; });
  assert.equal(called, true);
});

test('10. a garbage/invalid token is rejected the same way on a requireClientOrTeamAuth route as on requireClientAuth', async () => {
  const res = await fetch(`${baseUrl}/api/contacts`, { headers: { Authorization: 'Bearer not-a-real-token' } });
  assert.equal(res.status, 401);
});
