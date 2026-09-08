const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set (see .env.example)');
}

const hashPassword = (plain) => bcrypt.hash(plain, 10);
const comparePassword = (plain, hash) => bcrypt.compare(plain, hash);

function signClientToken(client) {
  return jwt.sign({ type: 'client', sub: client.id }, JWT_SECRET, { expiresIn: '7d' });
}

function signAdminToken(admin) {
  return jwt.sign({ type: 'admin', sub: admin.id, role: admin.role }, JWT_SECRET, { expiresIn: '1d' });
}

// clientId carried in the payload (not looked up from the DB on every
// request) is what lets requireClientOrTeamAuth resolve req.clientId
// identically for an owner or a team member without an extra query.
function signTeamMemberToken(teamMember) {
  return jwt.sign(
    { type: 'team_member', sub: teamMember.id, clientId: teamMember.client_id, role: teamMember.role },
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
