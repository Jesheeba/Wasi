const { Router } = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const subscriptionsRepo = require('../repositories/subscriptionsRepo');
const invoicesRepo = require('../repositories/invoicesRepo');
const clientsRepo = require('../repositories/clientsRepo');
const walletRepo = require('../repositories/walletRepo');
const paymentLinksRepo = require('../repositories/paymentLinksRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const { asyncHandler } = require('../utils/asyncHandler');

const router = Router();

function verifySignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  // Length check before timingSafeEqual — it throws on mismatched buffer
  // lengths rather than returning false, which would otherwise turn a
  // malformed/truncated signature header into a 500 instead of the clean
  // 401 every other invalid signature gets. Mirrors metaWebhook.js's
  // verifySignature, which already guards this the same way.
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

const RENEWAL_PERIOD_DAYS = 30;

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
    const renewsAt = new Date(Date.now() + RENEWAL_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const subscription = await subscriptionsRepo.updateByProviderRef(pool, orderId, { status: 'active', renews_at: renewsAt });
    await invoicesRepo.markStatusByOrderId(pool, orderId, 'paid', payment?.id);
    if (subscription) {
      const client = await clientsRepo.findById(pool, subscription.client_id);
      if (client && client.status === 'pending_setup') {
        await clientsRepo.update(pool, subscription.client_id, { status: 'payment_confirmed' });
      }
      await auditLogRepo.record({ actor_type: 'razorpay_webhook', actor_id: subscription.client_id, action: event, target: orderId });
    }
    // Same order id space, different table — an order is either a
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
  } else if (event === 'subscription.activated' || event === 'subscription.charged') {
    // GAP_FIX_PLAN.md Phase E4 — UNVERIFIED against a live Razorpay
    // account (see razorpayClient.js's createSubscription header); payload
    // shape here is inferred from Razorpay's documented Subscriptions
    // webhook format, not confirmed against a real delivery the way the
    // payment.captured branch above already has been. Only reachable once
    // a plan has a real razorpay_plan_id — dead code until then.
    const sub = req.body.payload?.subscription?.entity;
    if (sub?.id) {
      const renewsAt = sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null;
      const subscription = await subscriptionsRepo.updateByProviderRef(pool, sub.id, { status: 'active', renews_at: renewsAt });
      if (subscription) {
        const client = await clientsRepo.findById(pool, subscription.client_id);
        if (client && client.status === 'pending_setup') {
          await clientsRepo.update(pool, subscription.client_id, { status: 'payment_confirmed' });
        }
        // subscription.activated fires on the first authorization — no
        // charge has necessarily happened yet, so no invoice. Every
        // subsequent subscription.charged is a real completed payment for
        // one cycle, and (unlike the one-off flow) there's no pre-created
        // 'pending' invoice row for it to update — this is the only place
        // that cycle's invoice ever gets created, already paid.
        if (event === 'subscription.charged' && payment?.id) {
          await invoicesRepo.createPaid(pool, {
            client_id: subscription.client_id,
            subscription_id: subscription.id,
            plan: subscription.plan,
            amount_inr: Math.round((payment.amount || 0) / 100),
            razorpay_payment_id: payment.id,
          });
        }
        await auditLogRepo.record({ actor_type: 'razorpay_webhook', actor_id: subscription.client_id, action: event, target: sub.id });
      }
    }
  } else if (event === 'subscription.cancelled' || event === 'subscription.completed' || event === 'subscription.halted') {
    // halted = Razorpay gave up retrying a failed recurring charge (their
    // own dunning exhausted) — closest local equivalent to the one-off
    // flow's payment.failed, not a clean cancel.
    const sub = req.body.payload?.subscription?.entity;
    if (sub?.id) {
      const status = event === 'subscription.halted' ? 'payment_failed' : 'cancelled';
      const subscription = await subscriptionsRepo.updateByProviderRef(pool, sub.id, { status });
      if (subscription) {
        await auditLogRepo.record({ actor_type: 'razorpay_webhook', actor_id: subscription.client_id, action: event, target: sub.id });
      }
    }
  }

  res.sendStatus(200);
}));

module.exports = router;
