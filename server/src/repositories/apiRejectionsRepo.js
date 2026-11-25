// Hub API requests Wasi refused (migration 112). Privileged pool only.
const { pool } = require('../db/pool');

const RETENTION_DAYS = 30;

// Never throws: called while answering the API request, and a logging
// failure must not change what the caller receives.
async function record({ clientId, apiKeyId, method, path, status, code, message }) {
  try {
    await pool.query(
      `insert into api_rejections (client_id, api_key_id, method, path, status, code, message)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [clientId, apiKeyId || null, method, String(path).slice(0, 200), status, code, message ? String(message).slice(0, 500) : null]
    );
  } catch (err) {
    console.error('[apiRejectionsRepo] could not record a refused Hub API request:', err.message);
  }
}

async function listRecent(db, clientId, limit = 30) {
  const { rows } = await db.query(
    `select r.id, r.method, r.path, r.status, r.code, r.message, r.created_at, k.app_name
       from api_rejections r left join api_keys k on k.id = r.api_key_id
      where r.client_id = $1
      order by r.created_at desc
      limit $2`,
    [clientId, limit]
  );
  return rows;
}

async function purgeOld() {
  const { rowCount } = await pool.query(
    `delete from api_rejections where created_at < now() - make_interval(days => $1)`,
    [RETENTION_DAYS]
  );
  return rowCount;
}

module.exports = { record, listRecent, purgeOld, RETENTION_DAYS };
