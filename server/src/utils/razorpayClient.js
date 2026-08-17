// Thin wrapper around the Razorpay Orders API. Requires a real Razorpay account
// (RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET) — calls fail with a clear error otherwise.
const RAZORPAY_BASE = 'https://api.razorpay.com/v1';

function assertConfigured() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured (see .env.example)');
  }
}

function authHeader() {
  const token = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  return `Basic ${token}`;
}

// amountInPaise: integer, smallest currency unit (₹1 = 100 paise).
async function createOrder({ amountInPaise, currency = 'INR', receipt, notes }) {
  assertConfigured();
  const res = await fetch(`${RAZORPAY_BASE}/orders`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountInPaise, currency, receipt, notes }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.description || `Razorpay order creation failed (${res.status})`);
  }
  return data;
}

// Razorpay's Payment Links product — a shareable checkout URL, distinct from
// the Orders API used for subscription checkout (billing.js). This is the
// right primitive for "send a customer a link to pay ₹X" (Payments view /
// wallet recharge), where Orders would need a client-side checkout widget.
async function createPaymentLink({ amountInPaise, description, referenceId }) {
  assertConfigured();
  const res = await fetch(`${RAZORPAY_BASE}/payment_links`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountInPaise, currency: 'INR', description, reference_id: referenceId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.description || `Razorpay payment link creation failed (${res.status})`);
  }
  return data; // { id, short_url, status, ... }
}

module.exports = { createOrder, createPaymentLink };
