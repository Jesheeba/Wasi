const crypto = require('crypto');

// SHA-256, not bcrypt — see migration 014_hub_capability.js's module comment
// for why: a generated key is already high-entropy, and this needs to
// support an indexed `where key_hash = $1` lookup, which bcrypt's salted
// hash can't do.
function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// Returns the raw key (shown once, never stored) alongside the created row —
// same "generate, hash, persist only the hash" shape as authTokensRepo.
async function create(db, clientId, appName) {
  const rawKey = `wasi_${crypto.randomBytes(24).toString('hex')}`;
  const { rows } = await db.query(
    `insert into api_keys (client_id, app_name, key_hash)
     values ($1, $2, $3)
     returning *`,
    [clientId, appName, hashKey(rawKey)]
  );
  return { record: rows[0], rawKey };
}

async function findActiveByHash(db, rawKey) {
  const { rows } = await db.query(
    `select * from api_keys where key_hash = $1 and revoked_at is null`,
    [hashKey(rawKey)]
  );
  return rows[0] || null;
}

// Fire-and-forget from the caller's point of view — see
// middleware/requireApiKey.js. Not security-relevant, so a failure here
// shouldn't fail the request it's attached to.
async function touchLastUsed(db, id) {
  await db.query(`update api_keys set last_used_at = now() where id = $1`, [id]);
}

async function listByClientId(db, clientId) {
  const { rows } = await db.query(
    `select id, client_id, app_name, last_used_at, revoked_at, created_at
     from api_keys where client_id = $1 order by created_at desc`,
    [clientId]
  );
  return rows;
}

async function revoke(db, id, clientId) {
  const { rows } = await db.query(
    `update api_keys set revoked_at = now() where id = $1 and client_id = $2 and revoked_at is null returning *`,
    [id, clientId]
  );
  return rows[0] || null;
}

module.exports = { create, findActiveByHash, touchLastUsed, listByClientId, revoke };
