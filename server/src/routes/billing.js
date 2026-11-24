const { Router } = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { pool } = require('../db/pool');
const clientsRepo = require('../repositories/clientsRepo');
const { confirmSubscriptionPayment } = require('../services/subscriptionPayment');
const subscriptionsRepo = require('../repositories/subscriptionsRepo');
const invoicesRepo = require('../repositories/invoicesRepo');
const plansRepo = require('../repositories/plansRepo');
const razorpayClient = require('../utils/razorpayClient');
const { asyncHandler } = require('../utils/asyncHandler');
const { checkoutSchema, couponCheckSchema } = require('../utils/validate');

const router = Router();

// Single source of truth for coupon pricing - used by both the live preview
// (POST /coupon, called while the client types the code in) and the actual
// checkout below, so the two can never disagree about the price. Hardcoded
// here rather than a coupons table: one promo code, no admin UI requested to
// manage others yet - add a table if/when a second coupon or an expiry is needed.
const COUPONS = {
  WASIMR10: { amountInr: 1 },
};

function resolveCouponAmount(planRow, couponCode) {
  const code = (couponCode || '').trim().toUpperCase();
  if (!code) return { amountInr: planRow.price_inr, couponApplied: null };
  const coupon = COUPONS[code];
  if (!coupon) return { amountInr: null, couponApplied: null };
  return { amountInr: coupon.amountInr, couponApplied: code };
}

// Instant confirmation after Razorpay Checkout succeeds in the browser, so a
// new customer isn't held at the paywall until the webhook lands. Razorpay's
// documented check: HMAC-SHA256 of "order_id|payment_id" with the key secret.
// The order must be this client's own subscription checkout.
const verifyPaymentSchema = z.object({
  razorpay_order_id: z.string().min(1).max(100),
  razorpay_payment_id: z.string().min(1).max(100),
  razorpay_signature: z.string().min(1).max(200),
}).passthrough();

function validPaymentSignature(orderId, paymentId, signature) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex'));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

router.post('/verify-payment', asyncHandler(async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = verifyPaymentSchema.parse(req.body);
  if (!validPaymentSignature(orderId, paymentId, signature)) {
    return res.status(400).json({ error: 'Payment could not be verified.' });
  }
  const { rows } = await req.db.query(
    'select id from subscriptions where client_id = $1 and payment_provider_ref = $2', [req.clientId, orderId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No checkout found for this payment.' });
  // Commit this request's transaction first: confirmSubscriptionPayment
  // writes on the privileged pool (the webhook's path), outside req.db.
  await req.commitAndRelease();
  await confirmSubscriptionPayment(orderId, paymentId, { actorType: 'client', action: 'payment_verified' });
  const client = await clientsRepo.findById(pool, req.clientId);
  res.json({ ok: true, status: client.status });
}));

router.post('/coupon', asyncHandler(async (req, res) => {
  const { plan, couponCode } = couponCheckSchema.parse(req.body);
  const planRow = await plansRepo.findById(plan);
  if (!planRow) return res.status(400).json({ error: `Unknown plan: ${plan}` });

  const { amountInr, couponApplied } = resolveCouponAmount(planRow, couponCode);
  if (!couponApplied) return res.status(400).json({ error: 'Invalid coupon code.' });
  res.json({ couponApplied, amountInr, originalAmountInr: planRow.price_inr });
}));

router.get('/plans', asyncHandler(async (req, res) => {
  res.json(await plansRepo.list());
}));

router.get('/subscription', asyncHandler(async (req, res) => {
  const subscription = await subscriptionsRepo.findByClientId(req.db, req.clientId);
  res.json(subscription);
}));

router.get('/invoices', asyncHandler(async (req, res) => {
  res.json(await invoicesRepo.listByClientId(req.db, req.clientId));
}));

router.post('/checkout', asyncHandler(async (req, res) => {
  const { plan, couponCode } = checkoutSchema.parse(req.body);
  const planRow = await plansRepo.findById(plan);
  if (!planRow) return res.status(400).json({ error: `Unknown plan: ${plan}` });

  const { amountInr, couponApplied } = resolveCouponAmount(planRow, couponCode);
  if (couponCode && !couponApplied) {
    return res.status(400).json({ error: 'Invalid coupon code.' });
  }
  const amountInPaise = amountInr * 100;

  try {
    const order = await razorpayClient.createOrder({
      amountInPaise,
      receipt: `client_${req.clientId}_${plan}`,
      notes: { client_id: req.clientId, plan, ...(couponApplied ? { coupon: couponApplied } : {}) },
    });

    const subscription = await subscriptionsRepo.create(req.db, {
      client_id: req.clientId,
      plan,
      status: 'pending_payment',
      payment_provider_ref: order.id,
    });

    await invoicesRepo.create(req.db, {
      client_id: req.clientId,
      subscription_id: subscription.id,
      plan,
      amount_inr: amountInr,
      razorpay_order_id: order.id,
    });

    res.json({
      subscription,
      razorpayOrderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID || null,
      couponApplied,
    });
  } catch (err) {
    res.status(502).json({
      error: 'Checkout failed',
      detail: err.message,
      hint: 'This usually means RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are not configured yet.',
    });
  }
}));

// Client-initiated cancellation. We use Razorpay's one-off Orders API (not
// the Subscriptions product), so there's no recurring mandate to cancel on
// Razorpay's side - this just stops the client from being billed again at
// renewal. See DEPLOY.md / platform spec §7 if upgrading to real recurring
// billing later.
router.post('/cancel', asyncHandler(async (req, res) => {
  const subscription = await subscriptionsRepo.findByClientId(req.db, req.clientId);
  if (!subscription || subscription.status !== 'active') {
    return res.status(400).json({ error: 'No active subscription to cancel.' });
  }
  const updated = await subscriptionsRepo.updateByProviderRef(req.db, subscription.payment_provider_ref, { status: 'cancelled' });
  res.json(updated);
}));

module.exports = router;
