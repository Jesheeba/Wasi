const { Router } = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const subscriptionsRepo = require('../repositories/subscriptionsRepo');
const invoicesRepo = require('../repositories/invoicesRepo');
const { confirmSubscriptionPayment } = require('../services/subscriptionPayment');
const walletRepo = require('../repositories/walletRepo');
const paymentLinksRepo = require('../repositories/paymentLinksRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { reportPayment } = require('../utils/sirahosPayments');

const router = Router();

function verifySignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  // Length check before timingSafeEqual - it throws on mismatched buffer
  // lengths rather than returning false, which would otherwise turn a
  // malformed/truncated signature header into a 500 instead of the clean
  // 401 every other invalid signature gets. Mirrors metaWebhook.js's
  // verifySignature, which already guards this the same way (cherry-picked
  // from the unmerged origin/gap-fixes-a-e branch - see CLAUDE.md Known Gaps
  // for why only this fix, not that branch's bundled subscription-billing
  // code, was brought in: the latter calls invoicesRepo.createPaid, which
  // doesn't exist on master).
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

router.post('/', asyncHandler(async (req, res) => {
  const signature = req.get('x-razorpay-signature');
  if (!verifySignature(req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const event = req.body.event;
  const payment = req.body.payload?.payment?.entity;
  const refund = req.body.payload?.refund?.entity;
  const orderId = payment?.order_id || req.body.payload?.order?.entity?.id;

  if ((event === 'payment.captured' || event === 'order.paid') && orderId) {
    const subscription = await confirmSubscriptionPayment(orderId, payment?.id, { actorType: 'razorpay_webhook', action: event });
    if (subscription) {
      // Tell SirahOS, which holds the invoice. Not awaited and never throws:
      // Razorpay is waiting on this webhook and retries a non-2xx, which
      // would re-run everything above for a payment already recorded.
      // Razorpay amounts are in paise; SirahOS books rupees. Webhook only
      // (not billing.js's client-side verify), so one payment is reported
      // from one place; SirahOS dedupes Razorpay retries by payment id.
      void reportPayment({
        clientId: subscription.client_id,
        amount: (payment?.amount || 0) / 100,
        reference: payment?.id,
        kind: 'invoice',
      });
    }
    // Same order id space, different table - an order is either a
    // subscription checkout (above) or a wallet recharge (this), never both,
    // so trying both updates and letting the non-matching one no-op is
    // simpler and just as correct as inspecting notes.purpose to branch.
    const walletTx = await walletRepo.markStatusByOrderId(pool, orderId, 'completed');
    if (walletTx) {
      await auditLogRepo.record({ actor_type: 'razorpay_webhook', actor_id: walletTx.client_id, action: 'wallet_recharge_completed', target: orderId });
    }
  } else if (event === 'payment.failed' && orderId) {
    const subscription = await subscriptionsRepo.updateByProviderRef(pool, orderId, { status: 'payment_failed' });
    await invoicesRepo.markStatusByOrderId(pool, orderId, 'failed', payment?.id);
    if (subscription) {
      await auditLogRepo.record({ actor_type: 'razorpay_webhook', actor_id: subscription.client_id, action: event, target: orderId });
    }
    await walletRepo.markStatusByOrderId(pool, orderId, 'failed');
  } else if (event === 'refund.processed' && refund?.payment_id) {
    await invoicesRepo.markStatusByPaymentId(pool, refund.payment_id, 'refunded');
    await auditLogRepo.record({ actor_type: 'razorpay_webhook', actor_id: null, action: event, target: refund.payment_id });
  } else if (event === 'payment_link.paid') {
    const linkId = req.body.payload?.payment_link?.entity?.id;
    if (linkId) {
      await paymentLinksRepo.markStatusByRazorpayId(pool, linkId, 'paid');
      await auditLogRepo.record({ actor_type: 'razorpay_webhook', actor_id: null, action: event, target: linkId });
    }
  }

  res.sendStatus(200);
}));

module.exports = router;
