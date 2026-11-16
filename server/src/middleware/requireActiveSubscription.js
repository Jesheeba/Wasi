// Blocks a suspended client (or a team member under a suspended client)
// everywhere except billing, so they can pay their way out. Must run after
// requireClientAuth/requireClientOrTeamAuth, which sets req.clientStatus
// from the same query they already do for token_version - no extra query
// here. See build-docs/features/client-suspension-paywall.md.
function requireActiveSubscription(req, res, next) {
  if (req.clientStatus === 'suspended') {
    return res.status(402).json({ error: 'subscription_suspended' });
  }
  next();
}

module.exports = { requireActiveSubscription };
