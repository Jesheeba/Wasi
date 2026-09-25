const { verifyToken } = require('../utils/auth');
const { pool } = require('../db/pool');

// Session invalidation (password reset item 3): a token's `tokenVersion`
// claim must match admin_users.token_version at request time, not just
// verify as a signed, unexpired JWT — a password change bumps the column,
// which invalidates every token issued before it immediately, on the very
// next request, without a token blocklist. A token issued before this
// feature shipped carries no `tokenVersion` claim at all; treated as 0,
// which is every existing row's default, so it still passes until the row
// is actually bumped. A mismatch (or the admin no longer existing at all)
// gets the exact same response shape as an expired/invalid token, by
// instruction, so the frontend's existing 401 handling needs no changes.
function requireAdminAuth() {
  return async (req, res, next) => {
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
    if (payload.type !== 'admin') {
      return res.status(403).json({ error: 'Wrong token type' });
    }

    try {
      const { rows } = await pool.query('select token_version from admin_users where id = $1', [payload.sub]);
      const currentVersion = rows[0]?.token_version;
      if (currentVersion === undefined || (payload.tokenVersion ?? 0) !== currentVersion) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
    } catch (err) {
      return next(err);
    }

    req.adminId = payload.sub;
    req.adminRole = payload.role;
    next();
  };
}

module.exports = { requireAdminAuth };
