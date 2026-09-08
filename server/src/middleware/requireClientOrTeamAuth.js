const { verifyToken } = require('../utils/auth');

// Deliberately a SEPARATE middleware from requireClientAuth, not an
// extension of it — see PLAN.md item 1. requireClientAuth keeps accepting
// only `type: 'client'` and is left untouched on every router that should
// stay owner-only (onboarding, billing, wallet, client-webhook, api-keys,
// payment-links): a team_member token is rejected there at the JWT-type
// check itself, before any role logic ever runs. Only routers that should
// be reachable by SOME team-member role are switched to this middleware in
// app.js, each paired with requireRole(...) at the individual route level.
function requireClientOrTeamAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (payload.type === 'client') {
    req.clientId = payload.sub;
    req.actorType = 'owner';
    req.actorId = payload.sub;
    req.actorRole = 'Owner';
    return next();
  }

  if (payload.type === 'team_member') {
    req.clientId = payload.clientId;
    req.actorType = 'team_member';
    req.actorId = payload.sub;
    req.actorRole = payload.role;
    return next();
  }

  return res.status(403).json({ error: 'Wrong token type' });
}

module.exports = { requireClientOrTeamAuth };
