// build-docs/features/unpaid-signup-block.md - acceptance criteria.
// Real app + local test DB (TEST_DATABASE_URL). Razorpay is never called:
// the checkout rows are inserted directly and signatures are computed with a
// test key secret. Signups here are kept unpaid on purpose (x-test-keep-unpaid,
// see test/helpers/activateRegisteredClients.js).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const apiKeysRepo = require('../src/repositories/apiKeysRepo');
const subscriptionsRepo = require('../src/repositories/subscriptionsRepo');
const invoicesRepo = require('../src/repositories/invoicesRepo');
const { decide } = require('../src/services/aiAgent/gates');

process.env.RAZORPAY_KEY_SECRET = 'test-razorpay-key-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-razorpay-webhook-secret';

let server, BASE;
const created = [];
let ip = 0;

async function signup(tag) {
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-keep-unpaid': '1', 'X-Forwarded-For': `10.88.0.${++ip}` },
    body: JSON.stringify({ businessName: `__test_suite__unpaid ${tag}`, email: `test-unpaid-${tag}-${Date.now()}@wasi.local`, password: 'test-suite-password-12345' }),
  });
  const body = await r.json();
  assert.equal(r.status, 201);
  created.push(body.client.id);
  return { token: body.token, id: body.client.id };
}

const call = (path, token, init = {}) => fetch(`${BASE}${path}`, {
  ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
});
const status = async (id) => (await pool.query('select status from clients where id = $1', [id])).rows[0].status;

async function checkoutRow(clientId, orderId) {
  const sub = await subscriptionsRepo.create(pool, { client_id: clientId, plan: 'Starter', status: 'pending_payment', payment_provider_ref: orderId });
  await invoicesRepo.create(pool, { client_id: clientId, subscription_id: sub.id, plan: 'Starter', amount_inr: 1, razorpay_order_id: orderId });
  return sub;
}
const sign = (orderId, paymentId) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
const verify = (token, orderId, paymentId, signature = sign(orderId, paymentId)) => call('/api/billing/verify-payment', token, {
  method: 'POST', body: JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }),
});

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (created.length) {
    await pool.query("delete from audit_log where actor_id = any($1::uuid[])", [created]);
    await pool.query('delete from clients where id = any($1::uuid[])', [created]);
  }
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('AC1: a new, unpaid account can log in and reach billing, but nothing else (402 payment_required)', async () => {
  const { token, id } = await signup('ac1');
  assert.equal(await status(id), 'pending_setup');
  assert.equal((await call('/api/auth/me', token)).status, 200);
  assert.equal((await call('/api/billing/plans', token)).status, 200);
  for (const path of ['/api/contacts', '/api/chats', '/api/templates', '/api/broadcasts', '/api/onboarding/config', '/api/api-keys']) {
    const r = await call(path, token);
    assert.equal(r.status, 402, path);
    assert.deepEqual(await r.json(), { error: 'payment_required' }, path);
  }
});

test('AC2: the Hub API refuses keys of an unpaid or suspended account', async () => {
  const { id } = await signup('ac2');
  const key = await apiKeysRepo.create(pool, id, 'test-app');
  const raw = key.rawKey || key.raw_key || key.key;
  assert.ok(raw, 'apiKeysRepo.create returns the raw key');
  const hub = () => fetch(`${BASE}/api/v1/account`, { headers: { Authorization: `Bearer ${raw}` } });
  let r = await hub();
  assert.equal(r.status, 402);
  assert.equal((await r.json()).error.code, 'payment_required');
  await pool.query("update clients set status = 'suspended' where id = $1", [id]);
  r = await hub();
  assert.equal(r.status, 402);
  assert.equal((await r.json()).error.code, 'subscription_suspended');
  await pool.query("update clients set status = 'active' where id = $1", [id]);
  assert.equal((await hub()).status, 200, 'an active account\'s key works');
});

test('AC3: verify-payment with a valid signature unblocks the account at once', async () => {
  const { token, id } = await signup('ac3');
  const orderId = `order_test_${Date.now()}`;
  await checkoutRow(id, orderId);
  const r = await verify(token, orderId, 'pay_test_1');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'payment_confirmed');
  assert.equal(await status(id), 'payment_confirmed');
  const { rows: [sub] } = await pool.query('select status, renews_at from subscriptions where payment_provider_ref = $1', [orderId]);
  assert.equal(sub.status, 'active'); assert.ok(sub.renews_at);
  const { rows: [inv] } = await pool.query('select status from invoices where razorpay_order_id = $1', [orderId]);
  assert.equal(inv.status, 'paid');
  assert.equal((await call('/api/contacts', token)).status, 200, 'the app works after paying');
  assert.equal((await verify(token, orderId, 'pay_test_1')).status, 200, 'repeating it (or the webhook) is harmless');
});

test('AC4: verify-payment rejects a bad signature and another account\'s order, and changes nothing', async () => {
  const a = await signup('ac4a');
  const b = await signup('ac4b');
  const orderId = `order_test_b_${Date.now()}`;
  await checkoutRow(b.id, orderId);
  assert.equal((await verify(b.token, orderId, 'pay_x', 'f'.repeat(64))).status, 400, 'forged signature');
  assert.equal((await verify(b.token, orderId, 'pay_x', 'short')).status, 400, 'malformed signature');
  assert.equal((await verify(a.token, orderId, 'pay_x')).status, 404, 'a valid signature for someone else\'s order');
  assert.equal(await status(a.id), 'pending_setup');
  assert.equal(await status(b.id), 'pending_setup');
});

test('AC5: the Razorpay webhook still unblocks an unpaid account (same shared code)', async () => {
  const { id } = await signup('ac5');
  const orderId = `order_test_wh_${Date.now()}`;
  await checkoutRow(id, orderId);
  const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_wh_1', order_id: orderId } } } });
  const r = await fetch(`${BASE}/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex') },
    body: raw,
  });
  assert.equal(r.status, 200);
  assert.equal(await status(id), 'payment_confirmed');
});

test('AC6: paying lifts a non-payment suspension, but never an admin\'s own suspension', async () => {
  const auto = await signup('ac6a');
  const manual = await signup('ac6b');
  await pool.query("update clients set status = 'suspended', auto_suspended_for_nonpayment = true, payment_status = 'unpaid' where id = $1", [auto.id]);
  await pool.query("update clients set status = 'suspended', auto_suspended_for_nonpayment = false where id = $1", [manual.id]);
  const o1 = `order_test_s1_${Date.now()}`; const o2 = `order_test_s2_${Date.now()}`;
  await checkoutRow(auto.id, o1); await checkoutRow(manual.id, o2);
  assert.equal((await verify(auto.token, o1, 'pay_s1')).status, 200);
  assert.equal((await verify(manual.token, o2, 'pay_s2')).status, 200);
  const { rows: [a] } = await pool.query('select status, auto_suspended_for_nonpayment, payment_status from clients where id = $1', [auto.id]);
  assert.deepEqual([a.status, a.auto_suspended_for_nonpayment, a.payment_status], ['active', false, 'paid']);
  assert.equal(await status(manual.id), 'suspended');
});

test('AC7: the AI assistant is off for unpaid and suspended accounts', () => {
  const agent = { is_enabled: true, ai_consent_at: new Date(), client_id: 'x' };
  assert.equal(decide({ agent, client: { status: 'pending_setup' } }).detail.reason, 'payment_required');
  assert.equal(decide({ agent, client: { status: 'suspended' } }).detail.reason, 'subscription_suspended');
});
