// Database-level tenant isolation (build plan Phase 3). These tests exist to
// prove the database is doing the enforcing, not the app — see migration
// 013_tenant_isolation.js and server/src/middleware/tenantContext.js for the
// mechanism (a restricted `wasi_app` role, no BYPASSRLS, with
// app.current_client_id set via SET LOCAL inside a request-scoped
// transaction). Two disposable test clients, never the demo client — same
// reasoning as every other test file in this suite (see api.test.js).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const broadcastsRepo = require('../src/repositories/broadcastsRepo');

let server;
let baseUrl;
let clientA, clientB;

const SUITE_PREFIX = '__test_suite__tenant_isolation_';

async function registerClient(label) {
  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}${label}`,
      email: `test-suite-tenant-iso-${label}-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  return { token: registered.token, id: registered.client?.id };
}

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  clientA = await registerClient('a');
  clientB = await registerClient('b');
  assert.ok(clientA.token && clientA.id && clientB.token && clientB.id, 'both dedicated test clients must register');
});

after(async () => {
  if (clientA?.id) await pool.query('delete from clients where id = $1', [clientA.id]);
  if (clientB?.id) await pool.query('delete from clients where id = $1', [clientB.id]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('1. a query with NO client_id filter at all returns only the current tenant\'s rows — proves Postgres is enforcing it, not the app', async () => {
  // Client A gets a real contact through the normal API (normal app-layer
  // path, exercising the actual req.db/tenantContext wiring).
  const contactA = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: authed(clientA.token),
    body: JSON.stringify({ name: 'Tenant Isolation Contact A', phone: `91800${Date.now()}`.slice(0, 12) }),
  }).then((r) => r.json());
  assert.ok(contactA?.id);

  // Run the SAME unscoped query — no `where client_id = ...` anywhere in
  // the SQL text — once as each tenant, using the exact mechanism
  // tenantContext.js uses (BEGIN; SET LOCAL ROLE wasi_app; set_config), not
  // going through the app at all. If RLS weren't real, this query would
  // return every tenant's contacts regardless of which one is "current".
  async function unscopedContactIdsAs(clientId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wasi_app');
      await client.query(`select set_config('app.current_client_id', $1, true)`, [clientId]);
      const { rows } = await client.query('select id from contacts'); // deliberately no WHERE at all
      return rows.map((r) => r.id);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  const idsAsB = await unscopedContactIdsAs(clientB.id);
  assert.ok(!idsAsB.includes(contactA.id), 'tenant B must not see tenant A\'s contact from an unfiltered query');

  const idsAsA = await unscopedContactIdsAs(clientA.id);
  assert.ok(idsAsA.includes(contactA.id), 'tenant A must see its own contact from the same unfiltered query — proves this isn\'t just "always empty"');
});

test('2. the admin path still works — sees across every tenant, unaffected by RLS', async () => {
  const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: 'admin12345' }),
  }).then((r) => r.json());
  assert.ok(adminLogin.token, 'demo admin login must succeed — run `npm run db:seed` first');

  const overview = await fetch(`${baseUrl}/api/admin/overview`, { headers: authed(adminLogin.token) }).then((r) => r.json());
  assert.ok('clientsByStatus' in overview);

  // /api/clients (admin-only) must be able to see BOTH test clients created
  // in before() — a real cross-tenant read, not just "the request succeeded".
  const clients = await fetch(`${baseUrl}/api/clients`, { headers: authed(adminLogin.token) }).then((r) => r.json());
  const ids = clients.map((c) => c.id);
  assert.ok(ids.includes(clientA.id) && ids.includes(clientB.id), 'admin listing must see both tenants at once');
});

test('3. broadcastRunner\'s cross-client listing still sees broadcasts from multiple tenants in one call', async () => {
  // A broadcast with zero matching recipients is marked 'Completed'
  // immediately on creation (routes/broadcasts.js) — each client needs at
  // least one contact so its broadcast actually stays 'Sending' long enough
  // for listActive() to find it.
  await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: authed(clientA.token),
    body: JSON.stringify({ name: 'Tenant Isolation Recipient A', phone: `91801${Date.now()}`.slice(0, 12) }),
  });
  await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: authed(clientB.token),
    body: JSON.stringify({ name: 'Tenant Isolation Recipient B', phone: `91802${Date.now()}`.slice(0, 12) }),
  });

  const templateA = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST',
    headers: authed(clientA.token),
    body: JSON.stringify({ name: `${SUITE_PREFIX}template_a_${Date.now()}`, category: 'Utility', body: 'Hi {{customer_name}}, this is a dedicated tenant isolation test template.', bodyParamExamples: { customer_name: 'Riyaz' } }),
  }).then((r) => r.json());
  const templateB = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST',
    headers: authed(clientB.token),
    body: JSON.stringify({ name: `${SUITE_PREFIX}template_b_${Date.now()}`, category: 'Utility', body: 'Hi {{customer_name}}, this is a dedicated tenant isolation test template.', bodyParamExamples: { customer_name: 'Riyaz' } }),
  }).then((r) => r.json());

  const broadcastA = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST',
    headers: authed(clientA.token),
    body: JSON.stringify({ title: `${SUITE_PREFIX}broadcast_a`, templateName: templateA.name }),
  }).then((r) => r.json());
  const broadcastB = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST',
    headers: authed(clientB.token),
    body: JSON.stringify({ title: `${SUITE_PREFIX}broadcast_b`, templateName: templateB.name }),
  }).then((r) => r.json());

  // listActive/listDueScheduled are the queries broadcastRunner.tick() uses
  // to discover work across every client, by design (see migration
  // 013_tenant_isolation.js's module comment) — always the privileged pool,
  // never req.db. Calling tick() itself here would reach every real
  // 'Sending' broadcast in this shared dev database (including the demo
  // client's), which is exactly the live-data risk flagged earlier in this
  // project's history — so this checks the listing query directly instead.
  const active = await broadcastsRepo.listActive(pool);
  const activeIds = active.map((b) => b.id);
  assert.ok(activeIds.includes(broadcastA.id), 'broadcastRunner must still see tenant A\'s broadcast');
  assert.ok(activeIds.includes(broadcastB.id), 'broadcastRunner must still see tenant B\'s broadcast, in the same unfiltered call');
});

test('4. wabas.access_token_encrypted is unreadable by the restricted role', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE wasi_app');
    await assert.rejects(
      () => client.query('select access_token_encrypted from wabas limit 1'),
      /permission denied/i,
      'the restricted role must not be able to select this column, even with no rows matching'
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
