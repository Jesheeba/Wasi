// What a confirmed subscription payment does, shared by the Razorpay webhook
// and POST /api/billing/verify-payment (the browser's instant confirmation
// after checkout), so the two can never disagree. Idempotent: whichever
// arrives second repeats the same writes. See
// build-docs/features/unpaid-signup-block.md.
const { pool } = require('../db/pool');
const subscriptionsRepo = require('../repositories/subscriptionsRepo');
const invoicesRepo = require('../repositories/invoicesRepo');
const clientsRepo = require('../repositories/clientsRepo');
const auditLogRepo = require('../repositories/auditLogRepo');

const RENEWAL_PERIOD_DAYS = 30;

// Returns the subscription row, or null when the order is not a
// subscription checkout (e.g. a wallet recharge).
async function confirmSubscriptionPayment(orderId, paymentId, { actorType, action }) {
  const renewsAt = new Date(Date.now() + RENEWAL_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const subscription = await subscriptionsRepo.updateByProviderRef(pool, orderId, { status: 'active', renews_at: renewsAt });
  await invoicesRepo.markStatusByOrderId(pool, orderId, 'paid', paymentId);
  if (!subscription) return null;

  const client = await clientsRepo.findById(pool, subscription.client_id);
  if (client && client.status === 'pending_setup') {
    // First payment: unblocks the account (services/serviceAccess.js).
    await clientsRepo.update(pool, client.id, { status: 'payment_confirmed' });
  } else if (client && client.status === 'suspended' && client.auto_suspended_for_nonpayment) {
    // Paying lifts a suspension only when non-payment caused it - same rule
    // as admin's "mark paid" (routes/clients.js); an admin's own suspension stays.
    await clientsRepo.update(pool, client.id, {
      status: 'active', auto_suspended_for_nonpayment: false,
      payment_status: 'paid', payment_marked_unpaid_at: null, payment_warning_sent_at: null,
    });
  }
  await auditLogRepo.record({ actor_type: actorType, actor_id: subscription.client_id, action, target: orderId });
  return subscription;
}

module.exports = { confirmSubscriptionPayment, RENEWAL_PERIOD_DAYS };
