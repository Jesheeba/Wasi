const { verifyToken } = require('../utils/auth');

function requireAdminAuth(allowedRoles) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }

    try {
      const payload = verifyToken(token);
      if (payload.type !== 'admin') {
        return res.status(403).json({ error: 'Wrong token type' });
      }
      if (allowedRoles && !allowedRoles.includes(payload.role)) {
        return res.status(403).json({ error: 'Insufficient role' });
      }
      req.adminId = payload.sub;
      req.adminRole = payload.role;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

module.exports = { requireAdminAuth };
