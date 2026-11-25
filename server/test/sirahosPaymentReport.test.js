// SirahOS payment reporting (server/src/utils/sirahosPayments.js), which ran
// only as an uncommitted edit on the VPS until it was brought into the repo
// on 2026-11-25. SirahOS is never called: fetch is stubbed for its host only.
// The webhook tests use the real app on the local test DB (TEST_DATABASE_URL).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.RAZORPAY_KEY_SECRET = 'test-razorpay-key-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-razorpay-webhook-secret';
process.env.SIRAHOS_URL = 'https://sirahos.test.invalid/';
process.env.SIRAHOS_SECRET = 'test-sirahos-secret';

const { reportPayment } = require('../src/utils/sirahosPayments');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const subscriptionsRepo = require('../src/repositories/subscriptionsRepo');
const invoicesRepo = require('../src/repositories/invoicesRepo');

const realFetch = global.fetch;
let sirahosCalls = [];
let sirahosResponse = () => new Response('{}', { status: 200 });
global.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://sirahos.test.invalid')) {
    sirahosCalls.push({ url, init, body: JSON.parse(init.body) });
    return sirahosResponse();
  }
  return realFetch(input, init);
};

let server, BASE;
const created = [];
const waitForCalls = async (n) => {
  for (let i = 0; i < 50 && sirahosCalls.length < n; i++) await new Promise((r) => setTimeout(r, 20));
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://localhost:${server.address().port}`;
});

beforeEach(() => {
  sirahosCalls = [];
  sirahosResponse = () => new Response('{}', { status: 200 });
});

after(async () => {
  global.fetch = realFetch;
  if (created.length) {
    await pool.query('delete from audit_log where actor_id = any($1::uuid[])', [created]);
    await pool.query('delete from clients where id = any($1::uuid[])', [created]);
  }
  await new Promise((r) => server.close(r));
  await pool.end();
});

async function paidCheckout(tag) {
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-keep-unpaid': '1' },
    body: JSON.stringify({ businessName: `__test_suite__sirahos ${tag}`, email: `test-sirahos-${tag}-${Date.now()}@wasi.local`, password: 'test-suite-password-12345' }),
  });
  const body = await r.json();
  created.push(body.client.id);
  const orderId = `order_test_sirahos_${tag}_${Date.now()}`;
  const sub = await subscriptionsRepo.create(pool, { client_id: body.client.id, plan: 'Starter', status: 'pending_payment', payment_provider_ref: orderId });
  await invoicesRepo.create(pool, { client_id: body.client.id, subscription_id: sub.id, plan: 'Starter', amount_inr: 1499, razorpay_order_id: orderId });
  return { clientId: body.client.id, token: body.token, orderId };
}

function sendWebhook(event, orderId, paymentId, amountPaise) {
  const raw = JSON.stringify({ event, payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: amountPaise } } } });
  return fetch(`${BASE}/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex') },
    body: raw,
  });
}

test('reportPayment posts the payment to SirahOS with the shared secret', async () => {
  await reportPayment({ clientId: 'c-1', amount: 1499, reference: 'pay_1', kind: 'invoice' });
  assert.equal(sirahosCalls.length, 1);
  assert.equal(sirahosCalls[0].url, 'https://sirahos.test.invalid/api/payment-intake/wasi:c-1');
  assert.equal(sirahosCalls[0].init.headers['X-Sirahos-Signature'], 'test-sirahos-secret');
  assert.deepEqual(sirahosCalls[0].body, { amount: 1499, reference: 'pay_1', method: 'razorpay', kind: 'invoice' });
});

test('reportPayment does nothing without a secret, a client, a reference or a positive amount', async () => {
  process.env.SIRAHOS_SECRET = '';
  await reportPayment({ clientId: 'c-1', amount: 10, reference: 'pay_1' });
  process.env.SIRAHOS_SECRET = 'test-sirahos-secret';
  await reportPayment({ amount: 10, reference: 'pay_1' });
  await reportPayment({ clientId: 'c-1', amount: 10 });
  await reportPayment({ clientId: 'c-1', amount: 0, reference: 'pay_1' });
  assert.equal(sirahosCalls.length, 0);
});

test('reportPayment never throws when SirahOS fails or is unreachable', async () => {
  sirahosResponse = () => new Response('no project', { status: 404 });
  await reportPayment({ clientId: 'c-1', amount: 10, reference: 'pay_1' });
  sirahosResponse = () => { throw new Error('connect ECONNREFUSED'); };
  await reportPayment({ clientId: 'c-1', amount: 10, reference: 'pay_2' });
  assert.equal(sirahosCalls.length, 2);
});

test('webhook payment.captured reports the payment once, in rupees, as an invoice payment', async () => {
  const { clientId, orderId } = await paidCheckout('wh');
  const r = await sendWebhook('payment.captured', orderId, 'pay_wh_sirahos', 149900);
  assert.equal(r.status, 200);
  await waitForCalls(1);
  assert.equal(sirahosCalls.length, 1);
  assert.equal(sirahosCalls[0].url, `https://sirahos.test.invalid/api/payment-intake/wasi:${clientId}`);
  assert.deepEqual(sirahosCalls[0].body, { amount: 1499, reference: 'pay_wh_sirahos', method: 'razorpay', kind: 'invoice' });
});

test('webhook still answers 200 and confirms the payment when SirahOS is down', async () => {
  sirahosResponse = () => { throw new Error('connect ECONNREFUSED'); };
  const { clientId, orderId } = await paidCheckout('down');
  const r = await sendWebhook('payment.captured', orderId, 'pay_wh_down', 149900);
  assert.equal(r.status, 200);
  const { rows: [c] } = await pool.query('select status from clients where id = $1', [clientId]);
  assert.equal(c.status, 'payment_confirmed');
});

test('webhook for an order that is not a subscription (e.g. unknown order) reports nothing', async () => {
  const r = await sendWebhook('payment.captured', `order_unknown_${Date.now()}`, 'pay_unknown', 50000);
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(sirahosCalls.length, 0);
});

test('client-side verify-payment does not report (the webhook does, so it is never doubled)', async () => {
  const { token, orderId } = await paidCheckout('verify');
  const paymentId = 'pay_verify_sirahos';
  const signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  const r = await fetch(`${BASE}/api/billing/verify-payment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }),
  });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(sirahosCalls.length, 0);
});
