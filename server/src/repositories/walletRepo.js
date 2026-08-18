async function createPending(db, clientId, amountInr, razorpayOrderId) {
  const { rows } = await db.query(
    `insert into wallet_transactions (client_id, amount_inr, razorpay_order_id) values ($1, $2, $3) returning *`,
    [clientId, amountInr, razorpayOrderId]
  );
  return rows[0];
}

// Razorpay-webhook-triggered — looked up by order id, not a known client_id,
// so this always runs on the privileged connection.
async function markStatusByOrderId(db, orderId, status) {
  const { rows } = await db.query(
    `update wallet_transactions set status = $2 where razorpay_order_id = $1 returning *`,
    [orderId, status]
  );
  return rows[0] || null;
}

// Balance is derived from the ledger, not a stored counter — no risk of the
// two drifting apart.
async function balance(db, clientId) {
  const { rows } = await db.query(
    `select coalesce(sum(amount_inr), 0)::int as balance from wallet_transactions where client_id = $1 and status = 'completed'`,
    [clientId]
  );
  return rows[0].balance;
}

async function listByClientId(db, clientId) {
  const { rows } = await db.query('select * from wallet_transactions where client_id = $1 order by created_at desc', [clientId]);
  return rows;
}

module.exports = { createPending, markStatusByOrderId, balance, listByClientId };
