// Integration smoke suite: boots the real Express app against the real dev
// database (same one `npm run dev` uses) and drives it over HTTP, the way a
// client actually would. Requires Postgres reachable via DATABASE_URL and the
// seeded demo client/admin (`npm run db:seed`) to already exist.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;
let clientToken;
let adminToken;

// Every row this suite creates is tagged with this prefix so `after()` can
// clean it up by name/subject/title match — several routes have no DELETE
// endpoint (tags, broadcasts, automation rules, templates, tickets), so
// without this the dev database accumulates junk on every test run.
const SUITE_PREFIX = '__test_suite__';

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const clientLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@wasi.local', password: 'demo12345' }),
  }).then((r) => r.json());
  clientToken = clientLogin.token;
  assert.ok(clientToken, 'demo client login must succeed — run `npm run db:seed` first');

  const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: 'admin12345' }),
  }).then((r) => r.json());
  adminToken = adminLogin.token;
  assert.ok(adminToken, 'demo admin login must succeed — run `npm run db:seed` first');
});

after(async () => {
  // Clean up everything this suite created — these tables have no DELETE
  // route, so cleanup goes straight through the pool instead of the API.
  const like = `${SUITE_PREFIX}%`;
  await pool.query('delete from tags where name like $1', [like]);
  await pool.query('delete from broadcasts where title like $1', [like]);
  await pool.query('delete from automation_rules where title like $1', [like]);
  await pool.query('delete from message_templates where name like $1', [like]);
  await pool.query('delete from support_tickets where subject like $1', [like]);

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
  const template = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${SUITE_PREFIX}template_${Date.now()}`, category: 'Utility', body: 'Hello {{customer_name}}, thanks!' }),
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
  const templates = await fetch(`${baseUrl}/api/admin/templates`, { headers: authed(adminToken) }).then((r) => r.json());
  const target = templates[0];
  assert.ok(target, 'seed data must include at least one template');

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

test('onboarding: whatsapp connect fails cleanly with no Meta app configured', async () => {
  const res = await fetch(`${baseUrl}/api/onboarding/whatsapp/connect`, {
    method: 'POST',
    headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'fake', waba_id: 'fake-waba', phone_number_id: 'fake-phone' }),
  });
  assert.equal(res.status, 502); // expected: no META_APP_ID/SECRET in this environment
});

test('meta webhook: rejects an unsigned payload', async () => {
  const res = await fetch(`${baseUrl}/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry: [] }),
  });
  assert.equal(res.status, 401);
});
