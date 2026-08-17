const crypto = require('crypto');
const { pool } = require('../db/pool');

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Returns the raw token (goes in the emailed link, never stored) — only its
// hash is persisted, so a leaked database dump can't be used to reset an
// account's password or forge email verification.
async function create(subjectType, subjectId, purpose, ttlMinutes) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  await pool.query(
    `insert into auth_tokens (subject_type, subject_id, purpose, token_hash, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [subjectType, subjectId, purpose, hashToken(rawToken), expiresAt]
  );
  return rawToken;
}

// One-time use: an already-used or expired token is treated identically to
// an invalid one, so a reset-link replay can't work even within the TTL.
async function consume(rawToken, purpose) {
  const { rows } = await pool.query(
    `update auth_tokens set used_at = now()
     where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
     returning subject_type, subject_id`,
    [hashToken(rawToken), purpose]
  );
  return rows[0] || null;
}

module.exports = { create, consume };
