// Recurring billing (GAP_FIX_PLAN.md Phase E4) — covers what's testable
// without real Razorpay credentials (none are configured in this
// environment, see razorpayClient.js's header): that checkout's existing
// one-off behavior is provably unchanged (every seeded plan still has
// razorpay_plan_id = null), and that /cancel actually branches on
// billing_mode rather than silently treating every subscription the same
// way. Does NOT test a real Razorpay subscription create/charge/cancel —
// that needs a live account, same tradeoff as mediaHeaderService.test.js
// and inboundMedia.test.js's Meta-side equivalents.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;
let clientToken;
let testClientId;

const SUITE_PREFIX = '__test_suite__recurringBilling_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
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
      email: `test-suite-recurringbilling-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('every seeded plan still has razorpay_plan_id = null — recurring checkout branch is dead code today', async () => {
  const { rows } = await pool.query('select id, razorpay_plan_id from plans');
  assert.ok(rows.length > 0, 'plans table must be seeded');
  for (const plan of rows) {
    assert.equal(plan.razorpay_plan_id, null, `plan "${plan.id}" must not have a placeholder Razorpay plan id set by default`);
  }
});

test('checkout falls back to the one-off flow and fails the same way as before (no Razorpay configured)', async () => {
  const res = await fetch(`${baseUrl}/api/billing/checkout`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ plan: 'Starter' }),
  });
  // Unchanged baseline: RAZORPAY_KEY_ID/SECRET aren't configured in this
  // test environment, so createOrder() throws and the route's existing
  // catch block returns 502 with its original hint — proving the
  // razorpay_plan_id-gated recurring branch was correctly skipped (it
  // would fail differently, inside createSubscription, if accidentally
  // taken for a plan with no real plan id).
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.hint, /RAZORPAY_KEY_ID/);
});

test('cancelling a one_off subscription needs no Razorpay call and succeeds locally (unchanged behavior)', async () => {
  await pool.query(
    `insert into subscriptions (client_id, plan, status, payment_provider_ref, billing_mode)
     values ($1, 'Starter', 'active', $2, 'one_off')`,
    [testClientId, `${SUITE_PREFIX}order_ref`]
  );

  const res = await fetch(`${baseUrl}/api/billing/cancel`, { method: 'POST', headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'cancelled');
});

test('cancelling a recurring subscription actually attempts the Razorpay call, not just a local flip', async () => {
  await pool.query(
    `insert into subscriptions (client_id, plan, status, payment_provider_ref, billing_mode)
     values ($1, 'Growth', 'active', $2, 'recurring')`,
    [testClientId, `${SUITE_PREFIX}sub_ref`]
  );

  const res = await fetch(`${baseUrl}/api/billing/cancel`, { method: 'POST', headers: authed(clientToken) });
  // Proves the branch was taken: fails at razorpayClient.cancelSubscription
  // (no RAZORPAY_KEY_ID/SECRET here) with a distinct 502, rather than
  // silently succeeding with a local-only status flip the way a one_off
  // cancel correctly does above — the two must NOT behave identically.
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /Razorpay/);

  const { rows } = await pool.query(
    `select status from subscriptions where payment_provider_ref = $1`,
    [`${SUITE_PREFIX}sub_ref`]
  );
  assert.equal(rows[0].status, 'active', 'a failed Razorpay-side cancel must not have flipped the local status anyway');
});
