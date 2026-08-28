// Template Message Library (wasi-master-plan.md §2) — GET /api/template-library
// (browse/filter) and POST /api/template-library/:id/use (usage logging).
// Same dedicated-disposable-test-client pattern as apiKeysSelfServe.test.js:
// real Postgres via createApp(), a throwaway client per suite, deleted in
// after(). Runs against the real seeded content (seedTemplateLibrary.js),
// not synthetic fixtures — this IS the same content clients actually see.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;
let clientToken;
let testClientId;
let otherClientToken;
let otherClientId;

const SUITE_PREFIX = '__test_suite__templatelibrary_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function registerClient(suffix) {
  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client_${suffix}`,
      email: `test-suite-templatelibrary-${suffix}-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  return { token: registered.token, id: registered.client?.id };
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const primary = await registerClient('primary');
  clientToken = primary.token;
  testClientId = primary.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  const other = await registerClient('other');
  otherClientToken = other.token;
  otherClientId = other.id;
  assert.ok(otherClientToken && otherClientId, 'second dedicated test client registration must succeed');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  if (otherClientId) await pool.query('delete from clients where id = $1', [otherClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('GET /api/template-library: any authenticated client sees the real seeded content (not tenant-scoped)', async () => {
  const res = await fetch(`${baseUrl}/api/template-library`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  assert.ok(data.length >= 36, `expected at least the 36 seeded entries, got ${data.length}`);
  assert.ok(data.some((t) => t.industry === 'E-commerce' && t.use_case === 'abandoned_cart'));
  assert.ok(data.every((t) => t.is_active === true), 'listActive must never return an inactive row');
});

test('GET /api/template-library: rejects an unauthenticated request', async () => {
  const res = await fetch(`${baseUrl}/api/template-library`);
  assert.equal(res.status, 401);
});

test('GET /api/template-library?industry=: filters correctly', async () => {
  const res = await fetch(`${baseUrl}/api/template-library?industry=Healthcare`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.length >= 12);
  assert.ok(data.every((t) => t.industry === 'Healthcare'));
});

test('GET /api/template-library?category=: filters correctly', async () => {
  const res = await fetch(`${baseUrl}/api/template-library?category=Authentication`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.length >= 2);
  assert.ok(data.every((t) => t.category === 'Authentication'));
});

test('GET /api/template-library?use_case=: filters correctly, combines with other filters', async () => {
  const res = await fetch(
    `${baseUrl}/api/template-library?industry=E-commerce&use_case=abandoned_cart`,
    { headers: authed(clientToken) }
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.length, 1);
  assert.equal(data[0].title, 'Abandoned Cart Reminder');
  assert.ok(data[0].sample_values_json.customer_name);
});

test('GET /api/template-library?category=: rejects an invalid category value', async () => {
  const res = await fetch(`${baseUrl}/api/template-library?category=NotARealCategory`, { headers: authed(clientToken) });
  assert.equal(res.status, 400);
});

test('GET /api/template-library?use_case=: filters correctly on its own (no industry/category)', async () => {
  const res = await fetch(`${baseUrl}/api/template-library?use_case=appointment_reminder`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.length, 1);
  assert.equal(data[0].industry, 'Healthcare');
});

test('GET /api/template-library: industry+category combined (no use_case)', async () => {
  const res = await fetch(`${baseUrl}/api/template-library?industry=Healthcare&category=Utility`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.length >= 10);
  assert.ok(data.every((t) => t.industry === 'Healthcare' && t.category === 'Utility'));
});

test('GET /api/template-library: all three filters combined narrows to exactly one entry', async () => {
  const res = await fetch(
    `${baseUrl}/api/template-library?industry=General%2FOther&category=Authentication&use_case=account_verification_otp`,
    { headers: authed(clientToken) }
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.length, 1);
  assert.equal(data[0].title, 'Account Verification Code');
});

test('POST /api/template-library/:id/use: a malformed (non-UUID) id is rejected, not a 500', async () => {
  const res = await fetch(`${baseUrl}/api/template-library/not-a-real-uuid/use`, {
    method: 'POST',
    headers: authed(clientToken),
  });
  assert.equal(res.status, 400);
});

// Real negative case, not the trivially-true "every returned row happens to
// be active" check above (zero inactive rows exist in real seeded content,
// so that alone never actually exercises the WHERE is_active = true clause
// — a repo change that silently dropped the filter would still pass it).
// This flips one real row inactive, proves BOTH listActive and
// findActiveById genuinely exclude it, then restores it in finally —
// shared production content, not a disposable row, so it must not be left
// deactivated if this test fails partway through.
test('GET /api/template-library and POST .../:id/use both genuinely exclude an is_active=false row', async () => {
  const list = await fetch(
    `${baseUrl}/api/template-library?industry=E-commerce&use_case=abandoned_cart`,
    { headers: authed(clientToken) }
  ).then((r) => r.json());
  const targetId = list[0].id;

  await pool.query('update template_library set is_active = false where id = $1', [targetId]);
  try {
    const listRes = await fetch(`${baseUrl}/api/template-library`, { headers: authed(clientToken) });
    const listData = await listRes.json();
    assert.ok(!listData.some((t) => t.id === targetId), 'a deactivated row must not appear in the list once genuinely inactive');

    const useRes = await fetch(`${baseUrl}/api/template-library/${targetId}/use`, {
      method: 'POST',
      headers: authed(clientToken),
    });
    assert.equal(useRes.status, 404, 'a deactivated row must 404 on direct use, not silently succeed');
  } finally {
    await pool.query('update template_library set is_active = true where id = $1', [targetId]);
  }

  const restoredRes = await fetch(
    `${baseUrl}/api/template-library?industry=E-commerce&use_case=abandoned_cart`,
    { headers: authed(clientToken) }
  );
  const restoredData = await restoredRes.json();
  assert.ok(restoredData.some((t) => t.id === targetId), 'restore in finally must have taken effect');
});

test('POST /api/template-library/:id/use: records usage and returns the full entry', async () => {
  const list = await fetch(
    `${baseUrl}/api/template-library?industry=E-commerce&use_case=order_confirmation`,
    { headers: authed(clientToken) }
  ).then((r) => r.json());
  const entryId = list[0].id;

  const res = await fetch(`${baseUrl}/api/template-library/${entryId}/use`, {
    method: 'POST',
    headers: authed(clientToken),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.id, entryId);
  assert.equal(data.title, 'Order Confirmation');

  const usageRows = await pool.query(
    'select * from template_library_usage where library_template_id = $1 and client_id = $2',
    [entryId, testClientId]
  );
  assert.equal(usageRows.rows.length, 1, 'exactly one usage row must be recorded for this client+template');
});

test('POST /api/template-library/:id/use: usage is tenant-isolated by RLS — a different client\'s usage is invisible cross-tenant even querying the same library_template_id', async () => {
  const list = await fetch(
    `${baseUrl}/api/template-library?industry=E-commerce&use_case=order_confirmation`,
    { headers: authed(clientToken) }
  ).then((r) => r.json());
  const entryId = list[0].id;

  await fetch(`${baseUrl}/api/template-library/${entryId}/use`, { method: 'POST', headers: authed(otherClientToken) });

  // Real RLS check: connect as each client's own tenant context and confirm
  // each only ever sees their own usage rows for this shared library entry,
  // not the other client's — not just an application-level filter that
  // could be bypassed by a query missing a WHERE clause.
  const primaryRows = await queryAsTenant(testClientId, 'select * from template_library_usage where library_template_id = $1', [entryId]);
  const otherRows = await queryAsTenant(otherClientId, 'select * from template_library_usage where library_template_id = $1', [entryId]);
  assert.ok(primaryRows.every((r) => r.client_id === testClientId));
  assert.ok(otherRows.every((r) => r.client_id === otherClientId));
  assert.ok(otherRows.some((r) => r.client_id === otherClientId), 'the other client\'s own usage row must be visible to itself');
});

test('POST /api/template-library/:id/use: 404 for an unknown id', async () => {
  const res = await fetch(`${baseUrl}/api/template-library/00000000-0000-0000-0000-000000000099/use`, {
    method: 'POST',
    headers: authed(clientToken),
  });
  assert.equal(res.status, 404);
});

// Runs a query as the restricted wasi_app role with app.current_client_id
// set, exactly the way a real request's req.db does (tenantContext.js) —
// so this exercises the real RLS policy, not an application-level filter.
async function queryAsTenant(clientId, sql, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE wasi_app');
    await client.query(`select set_config('app.current_client_id', $1, true)`, [clientId]);
    const { rows } = await client.query(sql, params);
    await client.query('ROLLBACK');
    return rows;
  } finally {
    client.release();
  }
}
