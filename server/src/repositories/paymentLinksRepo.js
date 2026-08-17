const { pool } = require('../db/pool');

async function list(clientId) {
  const { rows } = await pool.query('select * from payment_links where client_id = $1 order by created_at desc', [clientId]);
  return rows;
}

async function create(clientId, { title, amount_inr, razorpay_payment_link_id, url }) {
  const { rows } = await pool.query(
    `insert into payment_links (client_id, title, amount_inr, razorpay_payment_link_id, url)
     values ($1, $2, $3, $4, $5) returning *`,
    [clientId, title, amount_inr, razorpay_payment_link_id || null, url || null]
  );
  return rows[0];
}

async function markStatusByRazorpayId(razorpayPaymentLinkId, status) {
  const { rows } = await pool.query(
    `update payment_links set status = $2 where razorpay_payment_link_id = $1 returning *`,
    [razorpayPaymentLinkId, status]
  );
  return rows[0] || null;
}

module.exports = { list, create, markStatusByRazorpayId };
