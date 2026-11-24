// Blocks an unpaid (pending_setup) or suspended client - and their team
// members - everywhere except billing and login, so they can pay their way
// in. Must run after requireClientAuth/requireClientOrTeamAuth, which sets
// req.clientStatus from the same query they already do for token_version -
// no extra query here. See build-docs/features/client-suspension-paywall.md
// and unpaid-signup-block.md.
const { serviceBlockReason } = require('../services/serviceAccess');

function requireActiveSubscription(req, res, next) {
  const reason = serviceBlockReason(req.clientStatus);
  if (reason) return res.status(402).json({ error: reason });
  next();
}

module.exports = { requireActiveSubscription };
