const { verifyToken } = require('../utils/auth');

function requireClientAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  try {
    const payload = verifyToken(token);
    if (payload.type !== 'client') {
      return res.status(403).json({ error: 'Wrong token type' });
    }
    req.clientId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireClientAuth };
