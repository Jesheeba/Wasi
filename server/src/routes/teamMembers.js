const { Router } = require('express');
const teamMembersRepo = require('../repositories/teamMembersRepo');
const authTokensRepo = require('../repositories/authTokensRepo');
const clientsRepo = require('../repositories/clientsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, teamMemberCreateSchema } = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');
const { sendEmail } = require('../utils/emailService');

const router = Router();

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// GET: any team member can see their own roster (matches PLAN.md item 1's
// route matrix). POST/DELETE and the invite trigger below are management
// actions, Admin/Manager only.
router.get('/', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  res.json(await teamMembersRepo.list(req.db, req.clientId));
}));

router.post('/', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  const data = teamMemberCreateSchema.parse(req.body);
  res.status(201).json(await teamMembersRepo.create(req.db, req.clientId, data));
}));

router.delete('/:id', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const deleted = await teamMembersRepo.remove(req.db, req.clientId, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

// PLAN.md item 1's invite endpoint. Uses the privileged pool for the token
// insert (authTokensRepo.create is always pool-based, matching routes/auth.js's
// own password-reset/email-verification calls) even though the team member
// and client lookups are tenant-scoped via req.db — the token isn't tenant data.
//
// The invite email must carry tenantSlug, not just the accept-invite token:
// POST /api/auth/team/login (routes/authTeam.js) needs {tenantSlug, email,
// password} together, since team_members.email is only unique per
// client_id, not globally (PLAN.md item 1, Open Question 1). accept-invite
// itself returns a working JWT immediately (auto-login for that one
// session), but with nothing telling the recipient their tenantSlug, EVERY
// login after that first session (a new browser, cleared storage, or just
// the 7-day token expiring) would be impossible — there'd be no way to fill
// in a field on the login form they were never shown. Found and fixed
// before this shipped, not discovered after a real invite went out.
router.post('/:id/invite', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const teamMember = await teamMembersRepo.findById(req.db, req.clientId, req.params.id);
  if (!teamMember) return res.status(404).json({ error: 'Not found' });
  const client = await clientsRepo.findById(req.db, req.clientId);

  const token = await authTokensRepo.create('team_member', teamMember.id, 'team_invite', 60 * 24 * 7);
  await sendEmail({
    to: teamMember.email,
    subject: `You have been invited to join ${client.name} on Wasi CRM`,
    html: `<p>You've been invited to join <strong>${client.name}</strong>'s team on Wasi CRM. Set your password to get started:</p>` +
      `<p><a href="${APP_URL}/marketing/accept-team-invite.html?token=${token}">Accept invite</a></p>` +
      `<p>Your organization ID for future logins is: <strong>${client.tenant_slug}</strong> — you'll need it along with your email and password.</p>`,
  });
  res.json({ invited: true });
}));

module.exports = router;
