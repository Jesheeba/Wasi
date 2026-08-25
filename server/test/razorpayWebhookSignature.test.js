// Razorpay webhook signature verification. Covers the three response
// shapes a caller can get: valid signature (200, event processed —
// or safely no-op'd if nothing matches, since the payloads below don't
// correspond to a real order/subscription), wrong signature (401), and a
// malformed/mismatched-length signature header (still 401, not a 500 —
// the regression this file exists to guard against: verifySignature() in
// razorpayWebhook.js used to call crypto.timingSafeEqual without a length
// check first, which throws a RangeError on mismatched-length buffers
// instead of returning false, matching metaWebhook.js's verifySignature
// which already guarded this the same way).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function payload() {
  return JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { order_id: 'order_does_not_exist', id: 'pay_test' } } },
  });
}

function signFor(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test('razorpay webhook: valid signature is accepted (200)', async () => {
  const body = payload();
  const signature = signFor(body, process.env.RAZORPAY_WEBHOOK_SECRET);
  const res = await fetch(`${baseUrl}/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
    body,
  });
  assert.equal(res.status, 200);
});

test('razorpay webhook: wrong secret is rejected (401, not 500)', async () => {
  const body = payload();
  const signature = signFor(body, 'not-the-real-secret');
  const res = await fetch(`${baseUrl}/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
    body,
  });
  assert.equal(res.status, 401);
});

test('razorpay webhook: mismatched-length signature header fails safe (401, not 500)', async () => {
  const body = payload();
  const res = await fetch(`${baseUrl}/webhooks/razorpay`, {
    method: 'POST',
    // Deliberately shorter than a real 64-char hex digest — this is exactly
    // the input shape that used to throw a RangeError out of
    // crypto.timingSafeEqual before the length check was added.
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'short' },
    body,
  });
  assert.equal(res.status, 401);
});
