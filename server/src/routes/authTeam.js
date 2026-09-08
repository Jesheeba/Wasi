const { Router } = require('express');
const { pool } = require('../db/pool');
const teamMembersRepo = require('../repositories/teamMembersRepo');
const clientsRepo = require('../repositories/clientsRepo');
const authTokensRepo = require('../repositories/authTokensRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { hashPassword, comparePassword, signTeamMemberToken } = require('../utils/auth');
const { teamAcceptInviteSchema, teamLoginSchema } = require('../utils/validate');
const { authLimiter, sessionCheckLimiter } = require('../middleware/rateLimit');
const { requireClientOrTeamAuth } = require('../middleware/requireClientOrTeamAuth');

const router = Router();

// Mounted at /api/auth/team (server/src/app.js), not tenant-scoped — a team
// member has no client_id-bound identity yet at the moment they're
// accepting an invite or logging in, so both handlers run on the privileged
// pool, same reasoning as routes/auth.js's own /login and /register.

router.post('/accept-invite', authLimiter, asyncHandler(async (req, res) => {
  const { token, password } = teamAcceptInviteSchema.parse(req.body);

  const consumed = await authTokensRepo.consume(token, 'team_invite');
  if (!consumed || consumed.subject_type !== 'team_member') {
    return res.status(400).json({ error: 'This invite link is invalid or has expired.' });
  }

  const password_hash = await hashPassword(password);
  const teamMember = await teamMembersRepo.setPassword(pool, consumed.subject_id, password_hash);
  if (!teamMember) return res.status(404).json({ error: 'Not found' });

  const jwt = signTeamMemberToken(teamMember);
  res.json({
    token: jwt,
    teamMember: { id: teamMember.id, name: teamMember.name, role: teamMember.role },
  });
}));

router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const { tenantSlug, email, password } = teamLoginSchema.parse(req.body);

  const teamMember = await teamMembersRepo.findForLogin(pool, tenantSlug, email);
  // A team member who hasn't accepted their invite yet has no password_hash
  // at all — treated identically to "wrong password" below, not a distinct
  // error, so this can't be used to enumerate which invites are pending.
  if (!teamMember || !teamMember.password_hash) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await comparePassword(password, teamMember.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  await teamMembersRepo.touchLastLogin(pool, teamMember.id);
  const token = signTeamMemberToken(teamMember);
  res.json({
    token,
    teamMember: { id: teamMember.id, name: teamMember.name, role: teamMember.role },
  });
}));

// Item 5.5's session-resume equivalent of routes/auth.js's GET /me, for a
// team_member token specifically — the frontend's resume-on-load IIFE needs
// SOME way to re-validate a stored team-member token and re-fetch fresh
// profile info on every page load, the same way it already does for an
// owner via /api/auth/me. requireClientOrTeamAuth (not requireClientAuth)
// is deliberate here — it's the one place an owner token hitting this route
// gets a clear, explicit 403 rather than the generic "wrong token type"
// requireClientAuth would give elsewhere, since an owner legitimately
// having this token isn't a security concern the way it is on the
// owner-only routers, just the wrong endpoint for them.
router.get('/me', sessionCheckLimiter, requireClientOrTeamAuth, asyncHandler(async (req, res) => {
  if (req.actorType !== 'team_member') {
    return res.status(403).json({ error: 'This endpoint is for team-member sessions only.' });
  }
  const teamMember = await teamMembersRepo.findById(pool, req.clientId, req.actorId);
  if (!teamMember) return res.status(404).json({ error: 'Not found' });
  const client = await clientsRepo.findById(pool, req.clientId);
  res.json({
    id: teamMember.id,
    name: teamMember.name,
    email: teamMember.email,
    role: teamMember.role,
    clientId: req.clientId,
    clientName: client?.name || null,
    tenantSlug: client?.tenant_slug || null,
  });
}));

module.exports = router;
