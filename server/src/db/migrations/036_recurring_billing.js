// GAP_FIX_PLAN.md Phase E4 — real recurring billing via Razorpay's
// Subscriptions product, chosen explicitly by the user over an in-house
// re-billing scheduler (gets Razorpay's own dunning/retry logic for free).
// Built as an additive, opt-in path per plan, not a replacement for the
// existing one-off Orders flow: plans.razorpay_plan_id starts NULL for
// every plan (a real Razorpay Plan doesn't exist yet — no Razorpay account
// is configured in this environment), and routes/billing.js falls back to
// the exact existing Orders-API behavior whenever it's null. Nothing about
// today's checkout/cancel behavior changes until an admin fills this in
// with a real Razorpay-created plan_id.
exports.up = (pgm) => {
  pgm.addColumn('plans', {
    razorpay_plan_id: { type: 'text' },
  });
  pgm.addColumn('subscriptions', {
    billing_mode: {
      type: 'text',
      notNull: true,
      default: 'one_off',
      check: "billing_mode in ('one_off', 'recurring')",
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('subscriptions', 'billing_mode');
  pgm.dropColumn('plans', 'razorpay_plan_id');
};
