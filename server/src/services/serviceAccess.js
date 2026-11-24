// Which client statuses may use Wasi. A blocked client keeps login and
// billing (so they can pay) and nothing else - app routes, the Hub API and
// the AI assistant all check this one function.
//   pending_setup - signed up, never paid
//   suspended     - service turned off (admin, or non-payment)
// payment_confirmed and active are allowed. Admin's Service toggle sets
// 'active', which is how an offline-paying or trial client is let in.
const BLOCKED = {
  pending_setup: 'payment_required',
  suspended: 'subscription_suspended',
};

function serviceBlockReason(status) {
  return BLOCKED[status] || null;
}

module.exports = { serviceBlockReason };
