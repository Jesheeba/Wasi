const { Router } = require('express');
const subscriptionsRepo = require('../repositories/subscriptionsRepo');
const invoicesRepo = require('../repositories/invoicesRepo');
const plansRepo = require('../repositories/plansRepo');
const razorpayClient = require('../utils/razorpayClient');
const { asyncHandler } = require('../utils/asyncHandler');
const { checkoutSchema } = require('../utils/validate');

const router = Router();

// Razorpay Subscriptions has no literal "bill until cancelled" — this is
// the documented convention for an open-ended monthly subscription
// (10 years of monthly cycles), relying on an explicit cancel rather than
// ever letting it run to completion. See razorpayClient.js's
// createSubscription for the rest of the GAP_FIX_PLAN.md Phase E4 caveats.
const RECURRING_TOTAL_CYCLES = 120;

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
    // Recurring path (GAP_FIX_PLAN.md Phase E4) — only reachable once an
    // admin sets plans.razorpay_plan_id for this plan to a real,
    // Razorpay-dashboard-created plan id. Every plan ships with this NULL,
    // so today this branch is dead code in every real deployment until
    // that's done — the fallback below is exactly today's existing
    // behavior, unchanged.
    if (planRow.razorpay_plan_id) {
      const rzpSubscription = await razorpayClient.createSubscription({
        planId: planRow.razorpay_plan_id,
        totalCount: RECURRING_TOTAL_CYCLES,
        notes: { client_id: req.clientId, plan },
      });

      const subscription = await subscriptionsRepo.create(req.db, {
        client_id: req.clientId,
        plan,
        status: 'pending_payment',
        payment_provider_ref: rzpSubscription.id,
        billing_mode: 'recurring',
      });

      // No Order in the Subscriptions flow — razorpay_order_id stays null;
      // razorpayWebhook.js's subscription.charged handler is what actually
      // marks this (and every later cycle's own new invoice row) paid.
      await invoicesRepo.create(req.db, {
        client_id: req.clientId,
        subscription_id: subscription.id,
        plan,
        amount_inr: planRow.price_inr,
        razorpay_order_id: null,
      });

      return res.json({
        subscription,
        subscriptionId: rzpSubscription.id,
        shortUrl: rzpSubscription.short_url,
        keyId: process.env.RAZORPAY_KEY_ID || null,
      });
    }

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
      billing_mode: 'one_off',
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

// Client-initiated cancellation. A 'recurring' subscription (Phase E4) has
// a real Razorpay mandate to cancel on their side, not just a local status
// flip — done first so a failure there (e.g. Razorpay's API is down)
// surfaces as a real error instead of silently leaving the client still
// billed next cycle while this app thinks they're cancelled. A 'one_off'
// subscription (still every plan today, until razorpay_plan_id is set)
// keeps its exact original behavior: Razorpay's Orders API has no
// recurring mandate to cancel at all, so this just stops the next manual
// re-checkout from happening — see DEPLOY.md / platform spec §7.
router.post('/cancel', asyncHandler(async (req, res) => {
  const subscription = await subscriptionsRepo.findByClientId(req.db, req.clientId);
  if (!subscription || subscription.status !== 'active') {
    return res.status(400).json({ error: 'No active subscription to cancel.' });
  }

  if (subscription.billing_mode === 'recurring') {
    try {
      await razorpayClient.cancelSubscription(subscription.payment_provider_ref);
    } catch (err) {
      return res.status(502).json({ error: 'Could not cancel with Razorpay', detail: err.message });
    }
  }

  const updated = await subscriptionsRepo.updateByProviderRef(req.db, subscription.payment_provider_ref, { status: 'cancelled' });
  res.json(updated);
}));

module.exports = router;
