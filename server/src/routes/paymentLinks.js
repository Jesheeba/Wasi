const { Router } = require('express');
const paymentLinksRepo = require('../repositories/paymentLinksRepo');
const razorpayClient = require('../utils/razorpayClient');
const { asyncHandler } = require('../utils/asyncHandler');
const { paymentLinkCreateSchema } = require('../utils/validate');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await paymentLinksRepo.list(req.clientId));
}));

router.post('/', asyncHandler(async (req, res) => {
  const { title, amount_inr } = paymentLinkCreateSchema.parse(req.body);

  try {
    const link = await razorpayClient.createPaymentLink({
      amountInPaise: amount_inr * 100,
      description: title,
      referenceId: `${req.clientId}_${Date.now()}`,
    });
    const saved = await paymentLinksRepo.create(req.clientId, {
      title,
      amount_inr,
      razorpay_payment_link_id: link.id,
      url: link.short_url,
    });
    res.status(201).json(saved);
  } catch (err) {
    res.status(502).json({
      error: 'Could not create payment link',
      detail: err.message,
      hint: 'This usually means RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are not configured yet.',
    });
  }
}));

module.exports = router;
