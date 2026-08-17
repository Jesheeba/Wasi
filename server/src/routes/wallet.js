const { Router } = require('express');
const walletRepo = require('../repositories/walletRepo');
const razorpayClient = require('../utils/razorpayClient');
const { asyncHandler } = require('../utils/asyncHandler');
const { walletRechargeSchema } = require('../utils/validate');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const [balance, transactions] = await Promise.all([
    walletRepo.balance(req.clientId),
    walletRepo.listByClientId(req.clientId),
  ]);
  res.json({ balance, transactions });
}));

// Reuses the Orders API + Razorpay Checkout.js widget (same pattern as
// billing.js's subscription checkout) — the frontend opens the widget with
// this order, and razorpayWebhook.js completes the credit on payment.captured.
router.post('/recharge', asyncHandler(async (req, res) => {
  const { amount_inr } = walletRechargeSchema.parse(req.body);
  try {
    const order = await razorpayClient.createOrder({
      amountInPaise: amount_inr * 100,
      receipt: `wallet_${req.clientId}_${Date.now()}`,
      notes: { client_id: req.clientId, purpose: 'wallet_recharge' },
    });
    await walletRepo.createPending(req.clientId, amount_inr, order.id);
    res.json({
      razorpayOrderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID || null,
    });
  } catch (err) {
    res.status(502).json({
      error: 'Recharge failed',
      detail: err.message,
      hint: 'This usually means RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are not configured yet.',
    });
  }
}));

module.exports = router;
