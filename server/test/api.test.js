// Integration smoke suite: boots the real Express app against the real dev
// database (same one `npm run dev` uses) and drives it over HTTP, the way a
// client actually would. Requires Postgres reachable via DATABASE_URL and
// the seeded demo admin (`npm run db:seed`) to already exist for admin-role
// tests — client-scoped tests use their own dedicated, disposable client
// (see below), not the demo client.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;
let clientToken;
let testClientId;
let adminToken;

// Every row this suite creates is tagged with this prefix for readability in
// assertions/logs — cleanup no longer depends on it (see after()), since
// everything now hangs off a dedicated client_id that gets cascade-deleted.
const SUITE_PREFIX = '__test_suite__';

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  // A brand-new, disposable client via the real registration endpoint —
  // not the demo client. The demo client is what Phase 2 live verification
  // uses (a genuinely connected real WABA, real seeded contacts) — a test
  // run that reuses it can corrupt that state (confirmed: this exact test
  // file used to overwrite the demo client's WABA row with fake values,
  // see git history) or, worse, cause a real send: broadcasts.create() with
  // no tag_id targets *every* contact on the client, and the live
  // broadcastRunner (ticking in the background dev server, sharing this
  // same database) picks up any 'Sending' broadcast within 5s regardless of
  // which process created it. A fresh client has zero contacts and no WABA,
  // so the same test actions here are structurally incapable of reaching a
  // real phone or a real Meta call.
  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client`,
      email: `test-suite-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: 'admin12345' }),
  }).then((r) => r.json());
  adminToken = adminLogin.token;
  assert.ok(adminToken, 'demo admin login must succeed — run `npm run db:seed` first');
});

after(async () => {
  // Cascade-deletes every row this suite created in one shot (contacts,
  // chats, messages, tags, broadcasts, automation_rules, message_templates,
  // support_tickets, wabas — all FK'd to clients with ON DELETE CASCADE).
  // No Meta-side cleanup needed: this client never had a WABA, so template
  // creation never left the local DB.
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);

  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function authed(token) {
  return { Authorization: `Bearer ${token}` };
}

test('GET /health returns ok', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
});

test('protected routes reject requests with no token', async () => {
  const res = await fetch(`${baseUrl}/api/contacts`);
  assert.equal(res.status, 401);
});

test('protected routes reject an invalid token', async () => {
  const res = await fetch(`${baseUrl}/api/contacts`, { headers: authed('not-a-real-token') });
  assert.equal(res.status, 401);
});

test('contacts: create, list, validation failure', async () => {
  const bad = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '+910000000000' }), // missing required name
  });
  assert.equal(bad.status, 400);

  const uniquePhone = `+91${Date.now()}`.slice(0, 13);
  const created = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Suite Contact', phone: uniquePhone }),
  }).then((r) => r.json());
  assert.equal(created.name, 'Test Suite Contact');

  const list = await fetch(`${baseUrl}/api/contacts`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.ok(list.some((c) => c.id === created.id));

  const del = await fetch(`${baseUrl}/api/contacts/${created.id}`, { method: 'DELETE', headers: authed(clientToken) });
  assert.equal(del.status, 204);
});

test('tags: create then appears in list', async () => {
  const name = `${SUITE_PREFIX}Tag ${Date.now()}`;
  const created = await fetch(`${baseUrl}/api/tags`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, bg: '#EEEEEE', color: '#111111' }),
  }).then((r) => r.json());
  assert.equal(created.name, name);

  const list = await fetch(`${baseUrl}/api/tags`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.ok(list.some((t) => t.id === created.id));
});

test('broadcasts, automation rules, templates: create + list round trip', async () => {
  const broadcast = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `${SUITE_PREFIX}Broadcast`, templateName: 'welcome_offer_v1' }),
  }).then((r) => r.json());
  assert.equal(broadcast.title, `${SUITE_PREFIX}Broadcast`);

  const rule = await fetch(`${baseUrl}/api/automation-rules`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `${SUITE_PREFIX}Rule`, trigger: 'keyword: test', action: 'send template' }),
  }).then((r) => r.json());
  assert.equal(rule.title, `${SUITE_PREFIX}Rule`);

  // Named parameters, not numbered — Meta rejects {{1}}-style now (see
  // server/test/templateParams.test.js for the dedicated coverage of that).
  // This test client has no WABA, so template creation only exercises local
  // validation + storage, never a real Meta call — but the body still needs
  // enough words per parameter to satisfy templateParams.js's local
  // words-ratio check (added after this exact body tripped real error
  // 2388293 when this suite briefly ran against a connected WABA).
  const template = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `${SUITE_PREFIX}template_${Date.now()}`,
      category: 'Utility',
      body: 'Hello {{customer_name}}, thank you so much for reaching out to us today — we truly appreciate your business and support!',
      bodyParamExamples: { customer_name: 'Riyaz' },
    }),
  }).then((r) => r.json());
  assert.equal(template.category, 'Utility');
});

test('templates: numbered parameters are rejected with 400 through the real route', async () => {
  const res = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${SUITE_PREFIX}bad_template`, category: 'Utility', body: 'Hello {{1}}, thanks!' }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.details.join(' '), /numbered parameters/i);
});

test('support tickets: client creates, admin sees and updates status', async () => {
  const ticket = await fetch(`${baseUrl}/api/support-tickets`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: `${SUITE_PREFIX}ticket`, message: 'This is a test ticket from the suite.' }),
  }).then((r) => r.json());
  assert.equal(ticket.status, 'open');

  const adminView = await fetch(`${baseUrl}/api/admin/tickets`, { headers: authed(adminToken) }).then((r) => r.json());
  assert.ok(adminView.some((t) => t.id === ticket.id));

  const updated = await fetch(`${baseUrl}/api/admin/tickets/${ticket.id}`, {
    method: 'PATCH',
    headers: { ...authed(adminToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'resolved' }),
  }).then((r) => r.json());
  assert.equal(updated.status, 'resolved');
});

test('admin: overview, billing overview, and settings status all respond', async () => {
  const overview = await fetch(`${baseUrl}/api/admin/overview`, { headers: authed(adminToken) }).then((r) => r.json());
  assert.ok('clientsByStatus' in overview);

  const billing = await fetch(`${baseUrl}/api/admin/billing/overview`, { headers: authed(adminToken) }).then((r) => r.json());
  assert.ok('estimatedMrr' in billing);

  const settings = await fetch(`${baseUrl}/api/admin/settings`, { headers: authed(adminToken) }).then((r) => r.json());
  assert.equal(settings.meta.configured, false); // no real Meta app in this test environment
});

test('admin: template status can be flipped and reverted', async () => {
  // Its own template, not templates[0] from the global admin list — flipping
  // an arbitrary existing template (previously: whichever the demo client
  // happened to have first) is exactly the kind of shared-state coupling
  // this suite is moving away from.
  const target = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `${SUITE_PREFIX}flip_target_${Date.now()}`,
      category: 'Utility',
      body: 'Hi {{customer_name}}, this is a dedicated test template just for the status-flip test.',
      bodyParamExamples: { customer_name: 'Riyaz' },
    }),
  }).then((r) => r.json());
  assert.ok(target?.id, 'template creation for this test must succeed');

  const rejected = await fetch(`${baseUrl}/api/admin/templates/${target.id}`, {
    method: 'PATCH',
    headers: { ...authed(adminToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'rejected' }),
  }).then((r) => r.json());
  assert.equal(rejected.status, 'rejected');

  const restored = await fetch(`${baseUrl}/api/admin/templates/${target.id}`, {
    method: 'PATCH',
    headers: { ...authed(adminToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: target.status }),
  }).then((r) => r.json());
  assert.equal(restored.status, target.status);
});

test('onboarding: whatsapp connect fails cleanly with a bogus code', async () => {
  // /api/onboarding/whatsapp/connect unconditionally upserts the given
  // waba_id/phone_number_id into the caller's wabas row before attempting
  // the Meta call. On the dedicated test client (never has a real WABA)
  // that's harmless; no snapshot/restore needed the way it was when this
  // ran against the demo client (see git history for that incident).
  // META_APP_ID/SECRET are real now (Phase 2), so this reaches real Meta and
  // fails because 'fake' isn't a real authorization code — same 502 either
  // way, just for a live-API reason now instead of a local not-configured one.
  const res = await fetch(`${baseUrl}/api/onboarding/whatsapp/connect`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'fake', waba_id: 'fake-waba', phone_number_id: 'fake-phone' }),
  });
  assert.equal(res.status, 502);
});

test('meta webhook: rejects an unsigned payload', async () => {
  const res = await fetch(`${baseUrl}/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry: [] }),
  });
  assert.equal(res.status, 401);
});
