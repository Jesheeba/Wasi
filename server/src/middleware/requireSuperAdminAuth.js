const { verifyToken } = require('../utils/auth');

// Deliberately its own middleware, not requireAdminAuth(['platform_admin']) —
// checks token TYPE, not just role, so a regular admin JWT can never reach
// super-admin routes even if role checking were somehow bypassed elsewhere.
// See migration 017_super_admin_role.js's module comment.
function requireSuperAdminAuth() {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }

    try {
      const payload = verifyToken(token);
      if (payload.type !== 'super_admin') {
        return res.status(403).json({ error: 'Wrong token type' });
      }
      req.superAdminId = payload.sub;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

module.exports = { requireSuperAdminAuth };
