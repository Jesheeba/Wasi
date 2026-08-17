const { pool } = require('../db/pool');

async function create({ client_id, subscription_id, plan, amount_inr, razorpay_order_id }) {
  const { rows } = await pool.query(
    `insert into invoices (client_id, subscription_id, plan, amount_inr, razorpay_order_id)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [client_id, subscription_id, plan, amount_inr, razorpay_order_id]
  );
  return rows[0];
}

async function markStatusByOrderId(orderId, status, paymentId) {
  const { rows } = await pool.query(
    `update invoices set status = $2, razorpay_payment_id = coalesce($3, razorpay_payment_id)
     where razorpay_order_id = $1 returning *`,
    [orderId, status, paymentId || null]
  );
  return rows[0] || null;
}

async function markStatusByPaymentId(paymentId, status) {
  const { rows } = await pool.query(
    `update invoices set status = $2 where razorpay_payment_id = $1 returning *`,
    [paymentId, status]
  );
  return rows[0] || null;
}

async function listByClientId(clientId) {
  const { rows } = await pool.query(
    'select * from invoices where client_id = $1 order by created_at desc',
    [clientId]
  );
  return rows;
}

module.exports = { create, markStatusByOrderId, markStatusByPaymentId, listByClientId };
