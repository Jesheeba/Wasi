const { verifyToken } = require('../utils/auth');
const { pool } = require('../db/pool');

// Session invalidation (password reset item 3) — see requireAdminAuth.js's
// identical comment for the full reasoning; this is the same check against
// clients.token_version instead of admin_users'.
async function requireClientAuth(req, res, next) {
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
  if (payload.type !== 'client') {
    return res.status(403).json({ error: 'Wrong token type' });
  }

  try {
    const { rows } = await pool.query('select token_version from clients where id = $1', [payload.sub]);
    const currentVersion = rows[0]?.token_version;
    if (currentVersion === undefined || (payload.tokenVersion ?? 0) !== currentVersion) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  } catch (err) {
    return next(err);
  }

  req.clientId = payload.sub;
  next();
}

module.exports = { requireClientAuth };
