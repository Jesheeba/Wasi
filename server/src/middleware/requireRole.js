// Applied per-route (not once per router) behind requireClientOrTeamAuth,
// per PLAN.md item 1's route-by-route role matrix. The owner (req.actorType
// === 'owner') always passes regardless of the list — the client account
// itself is the ultimate authority on its own data. A team_member token
// passes only if req.actorRole is literally in the allowed list.
//
// Calling this with NO arguments denies every team-member role — the
// explicit fail-closed default for any route someone forgets to annotate.
function requireRole(...allowedRoles) {
  return function (req, res, next) {
    if (req.actorType === 'owner') return next();
    if (req.actorType === 'team_member' && allowedRoles.includes(req.actorRole)) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden for this role' });
  };
}

module.exports = { requireRole };
