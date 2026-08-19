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

// Distinct token type from signAdminToken, not just a distinct role claim —
// see migration 017_super_admin_role.js's module comment for why that
// distinction is the actual security boundary here.
function signSuperAdminToken(admin) {
  return jwt.sign({ type: 'super_admin', sub: admin.id, role: admin.role }, JWT_SECRET, { expiresIn: '1d' });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = {
  hashPassword,
  comparePassword,
  signClientToken,
  signAdminToken,
  signSuperAdminToken,
  verifyToken,
};
