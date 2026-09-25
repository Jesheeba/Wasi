const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set (see .env.example)');
}

const hashPassword = (plain) => bcrypt.hash(plain, 10);
const comparePassword = (plain, hash) => bcrypt.compare(plain, hash);

// tokenVersion is the session-invalidation epoch (server/src/db/migrations/
// 079_identity_token_version.js) — the auth middleware compares this claim
// against the subject's current token_version column on every request, so a
// password change/reset can invalidate every token issued before it without
// a token blocklist. `client.token_version`/etc. is expected to already be
// on the row passed in here (every caller fetches it via a `select *` or an
// explicit column list that includes it) — defaulting to 0 below only covers
// a caller that hasn't been updated to select it, not the "old token"
// case (that's handled on the verify side, not here).
function signClientToken(client) {
  return jwt.sign(
    { type: 'client', sub: client.id, tokenVersion: client.token_version ?? 0 },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function signAdminToken(admin) {
  return jwt.sign(
    { type: 'admin', sub: admin.id, role: admin.role, tokenVersion: admin.token_version ?? 0 },
    JWT_SECRET,
    { expiresIn: '1d' }
  );
}

// clientId carried in the payload (not looked up from the DB on every
// request) is what lets requireClientOrTeamAuth resolve req.clientId
// identically for an owner or a team member without an extra query.
function signTeamMemberToken(teamMember) {
  return jwt.sign(
    {
      type: 'team_member',
      sub: teamMember.id,
      clientId: teamMember.client_id,
      role: teamMember.role,
      tokenVersion: teamMember.token_version ?? 0,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = {
  hashPassword,
  comparePassword,
  signClientToken,
  signAdminToken,
  signTeamMemberToken,
  verifyToken,
};
