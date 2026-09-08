// PLAN.md item 15 — Meta conversation pricing / cost calculator. Covers:
// admin CRUD on conversation_pricing (create/upsert-by-conflict, list,
// delete, auth gating), and the client-facing GET /api/analytics/
// cost-estimate — an explicit what-if calculator (see analytics.js's own
// comment: usage_logs.conversations_billed has no category/country
// dimension, so category/countryCode are required query params, and there
// is deliberately no byCategory breakdown in the response).
//
// Same dedicated-disposable-test-client + demo-admin-login pattern as
// adminSecretMasking.test.js. Deletes every row this file inserts into
// conversation_pricing (a real shared, non-tenant-scoped table) in after(),
// per CLAUDE.md's "a test can delete/leave behind real shared-table
// content" convention — nothing here touches any OTHER row.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server, baseUrl, clientToken, testClientId, adminToken;
const createdRateIds = [];

const SUITE_PREFIX = '__test_suite__convpricing_';
// A country code unlikely to collide with any other test file or real
// admin-entered rate on this shared table.
const TEST_COUNTRY = 'ZZ';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function upsertRate(category, countryCode, rateInr) {
  const res = await fetch(`${baseUrl}/api/admin/conversation-pricing`, {
    method: 'POST',
    headers: authed(adminToken),
    body: JSON.stringify({ category, countryCode, rateInr }),
  });
  const body = await res.json();
  if (res.status === 201) createdRateIds.push(body.id);
  return { res, body };
}

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
      email: `test-suite-convpricing-${Date.now()}@wasi.local`,
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
  for (const id of createdRateIds) {
    await pool.query('delete from conversation_pricing where id = $1', [id]);
  }
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('admin CRUD: create, list, and upsert-by-conflict updates the rate in place, not a duplicate row', async () => {
  const { res: createRes, body: created } = await upsertRate('UTILITY', TEST_COUNTRY, 0.5);
  assert.equal(createRes.status, 201);
  assert.equal(created.category, 'UTILITY');
  assert.equal(created.country_code, TEST_COUNTRY);
  assert.equal(Number(created.rate_inr), 0.5);

  const listRes = await fetch(`${baseUrl}/api/admin/conversation-pricing`, { headers: authed(adminToken) });
  const list = await listRes.json();
  assert.equal(listRes.status, 200);
  const row = list.find((r) => r.id === created.id);
  assert.ok(row, 'the created rate must appear in the list');

  // Re-submitting the SAME (category, country_code) with a new rate must
  // update in place, not create a second row.
  const { res: updateRes, body: updated } = await upsertRate('UTILITY', TEST_COUNTRY, 0.65);
  assert.equal(updateRes.status, 201);
  assert.equal(updated.id, created.id, 'upsert on the same (category, country_code) must update the existing row, not insert a new one');
  assert.equal(Number(updated.rate_inr), 0.65);

  const listAfter = await fetch(`${baseUrl}/api/admin/conversation-pricing`, { headers: authed(adminToken) })
    .then((r) => r.json());
  const matching = listAfter.filter((r) => r.category === 'UTILITY' && r.country_code === TEST_COUNTRY);
  assert.equal(matching.length, 1, 'still exactly one row for this (category, country_code) pair after the upsert');
});

test('admin CRUD: DELETE removes a rate; deleting an unknown id 404s', async () => {
  const { body: created } = await upsertRate('MARKETING', TEST_COUNTRY, 1.2);

  const delRes = await fetch(`${baseUrl}/api/admin/conversation-pricing/${created.id}`, {
    method: 'DELETE',
    headers: authed(adminToken),
  });
  assert.equal(delRes.status, 204);
  createdRateIds.splice(createdRateIds.indexOf(created.id), 1);

  const listAfter = await fetch(`${baseUrl}/api/admin/conversation-pricing`, { headers: authed(adminToken) })
    .then((r) => r.json());
  assert.ok(!listAfter.some((r) => r.id === created.id), 'deleted rate must not appear in the list anymore');

  const missingDelRes = await fetch(`${baseUrl}/api/admin/conversation-pricing/${created.id}`, {
    method: 'DELETE',
    headers: authed(adminToken),
  });
  assert.equal(missingDelRes.status, 404);
});

test('admin CRUD: rejects an unrecognized category, and requires auth', async () => {
  const badCategoryRes = await fetch(`${baseUrl}/api/admin/conversation-pricing`, {
    method: 'POST',
    headers: authed(adminToken),
    body: JSON.stringify({ category: 'NOT_A_REAL_CATEGORY', countryCode: TEST_COUNTRY, rateInr: 1 }),
  });
  assert.equal(badCategoryRes.status, 400);

  const unauthedRes = await fetch(`${baseUrl}/api/admin/conversation-pricing`, {
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(unauthedRes.status, 401);

  // A client (owner) token must not reach an admin-only route either —
  // requireAdminAuth() rejects a wrong-token-type JWT with 403, reserving
  // 401 for genuinely missing/invalid credentials (matches this codebase's
  // established convention, e.g. teamMemberAuth.test.js's own 403 case).
  const clientTokenRes = await fetch(`${baseUrl}/api/admin/conversation-pricing`, { headers: authed(clientToken) });
  assert.equal(clientTokenRes.status, 403);
});

test('GET /api/analytics/cost-estimate: with a rate configured, the estimate matches a manual calculation', async () => {
  await upsertRate('AUTHENTICATION', TEST_COUNTRY, 0.4);

  const month = '2020-01'; // a month with no real production traffic on this test client
  await pool.query(
    `insert into usage_logs (client_id, date, conversations_billed)
     values ($1, $2, $3), ($1, $4, $5)
     on conflict (client_id, date) do update set conversations_billed = excluded.conversations_billed`,
    [testClientId, `${month}-05`, 10, `${month}-20`, 15]
  );

  const res = await fetch(
    `${baseUrl}/api/analytics/cost-estimate?month=${month}&category=AUTHENTICATION&countryCode=${TEST_COUNTRY}`,
    { headers: authed(clientToken) }
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.conversationsBilled, 25, '10 + 15 across the two days in this month');
  assert.equal(body.rateConfigured, true);
  assert.equal(body.rateInr, 0.4);
  assert.equal(body.estimatedInr, 10, '25 conversations * 0.4 INR = 10, matching a manual calculation');
  // The response is deliberately total-only — no per-category split is
  // fabricated from data usage_logs doesn't actually carry.
  assert.equal(body.byCategory, undefined, 'byCategory must not appear — see analytics.js\'s own comment on why');
});

test('GET /api/analytics/cost-estimate: with no rate configured, reports that clearly rather than a silent 0', async () => {
  const month = '2020-02';
  await pool.query(
    `insert into usage_logs (client_id, date, conversations_billed)
     values ($1, $2, $3)
     on conflict (client_id, date) do update set conversations_billed = excluded.conversations_billed`,
    [testClientId, `${month}-01`, 7]
  );

  // SERVICE/TEST_COUNTRY was never configured by any test above.
  const res = await fetch(
    `${baseUrl}/api/analytics/cost-estimate?month=${month}&category=SERVICE&countryCode=${TEST_COUNTRY}`,
    { headers: authed(clientToken) }
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.conversationsBilled, 7, 'the real billed count is still reported even with no rate configured');
  assert.equal(body.rateConfigured, false);
  assert.equal(body.rateInr, null);
  assert.equal(body.estimatedInr, null, 'must not silently report 0 — that would be indistinguishable from a real zero-cost month');
});

test('GET /api/analytics/cost-estimate: requires month/category/countryCode; rejects an unrecognized category', async () => {
  const missingParams = await fetch(`${baseUrl}/api/analytics/cost-estimate`, { headers: authed(clientToken) });
  assert.equal(missingParams.status, 400);

  const badCategory = await fetch(
    `${baseUrl}/api/analytics/cost-estimate?month=2020-01&category=NOT_REAL&countryCode=${TEST_COUNTRY}`,
    { headers: authed(clientToken) }
  );
  assert.equal(badCategory.status, 400);

  const badMonth = await fetch(
    `${baseUrl}/api/analytics/cost-estimate?month=not-a-month&category=UTILITY&countryCode=${TEST_COUNTRY}`,
    { headers: authed(clientToken) }
  );
  assert.equal(badMonth.status, 400);
});

test('GET /api/analytics/cost-estimate: tenant-scoped — another client\'s usage never leaks into this estimate', async () => {
  await upsertRate('UTILITY', TEST_COUNTRY, 1);

  const otherClient = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}other_client`,
      email: `test-suite-convpricing-other-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  const otherClientId = otherClient.client.id;

  const month = '2020-03';
  await pool.query(
    `insert into usage_logs (client_id, date, conversations_billed) values ($1, $2, 999)`,
    [otherClientId, `${month}-01`]
  );

  const res = await fetch(
    `${baseUrl}/api/analytics/cost-estimate?month=${month}&category=UTILITY&countryCode=${TEST_COUNTRY}`,
    { headers: authed(clientToken) }
  ).then((r) => r.json());
  assert.equal(res.conversationsBilled, 0, 'the calling client has no usage this month — the other client\'s 999 must not appear');

  await pool.query('delete from clients where id = $1', [otherClientId]);
});
