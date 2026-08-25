async function create(db, { client_id, subscription_id, plan, amount_inr, razorpay_order_id }) {
  const { rows } = await db.query(
    `insert into invoices (client_id, subscription_id, plan, amount_inr, razorpay_order_id)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [client_id, subscription_id, plan, amount_inr, razorpay_order_id]
  );
  return rows[0];
}

// Recurring-cycle invoices (GAP_FIX_PLAN.md Phase E4, subscription.charged
// webhook handling) — unlike the one-off flow's create()-then-later-
// markStatusByOrderId() two step, a recurring charge is already a
// completed, successful payment by the time Razorpay tells us about it
// (there's no local "pending" invoice pre-created for a future cycle to
// update against — this webhook is the only place that cycle's invoice
// ever gets created), so this creates it already marked paid in one write.
async function createPaid(db, { client_id, subscription_id, plan, amount_inr, razorpay_payment_id }) {
  const { rows } = await db.query(
    `insert into invoices (client_id, subscription_id, plan, amount_inr, status, razorpay_payment_id)
     values ($1, $2, $3, $4, 'paid', $5)
     returning *`,
    [client_id, subscription_id, plan, amount_inr, razorpay_payment_id]
  );
  return rows[0];
}

// Razorpay-webhook-triggered — looked up by order/payment id, not a known
// client_id, so these always run on the privileged connection.
async function markStatusByOrderId(db, orderId, status, paymentId) {
  const { rows } = await db.query(
    `update invoices set status = $2, razorpay_payment_id = coalesce($3, razorpay_payment_id)
     where razorpay_order_id = $1 returning *`,
    [orderId, status, paymentId || null]
  );
  return rows[0] || null;
}

async function markStatusByPaymentId(db, paymentId, status) {
  const { rows } = await db.query(
    `update invoices set status = $2 where razorpay_payment_id = $1 returning *`,
    [paymentId, status]
  );
  return rows[0] || null;
}

async function listByClientId(db, clientId) {
  const { rows } = await db.query(
    'select * from invoices where client_id = $1 order by created_at desc',
    [clientId]
  );
  return rows;
}

module.exports = { create, createPaid, markStatusByOrderId, markStatusByPaymentId, listByClientId };
