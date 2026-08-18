const { Router } = require('express');
const subscriptionsRepo = require('../repositories/subscriptionsRepo');
const invoicesRepo = require('../repositories/invoicesRepo');
const plansRepo = require('../repositories/plansRepo');
const razorpayClient = require('../utils/razorpayClient');
const { asyncHandler } = require('../utils/asyncHandler');
const { checkoutSchema } = require('../utils/validate');

const router = Router();

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
  const { plan } = checkoutSchema.parse(req.body);
  const planRow = await plansRepo.findById(plan);
  if (!planRow) return res.status(400).json({ error: `Unknown plan: ${plan}` });
  const amountInPaise = planRow.price_inr * 100;

  try {
    const order = await razorpayClient.createOrder({
      amountInPaise,
      receipt: `client_${req.clientId}_${plan}`,
      notes: { client_id: req.clientId, plan },
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
      amount_inr: planRow.price_inr,
      razorpay_order_id: order.id,
    });

    res.json({
      subscription,
      razorpayOrderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID || null,
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
// Razorpay's side — this just stops the client from being billed again at
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
