const { pool } = require('../db/pool');

async function findOpen(alertType, dedupKey) {
  const { rows } = await pool.query(
    `select * from alert_events where alert_type = $1 and dedup_key = $2 and resolved_at is null`,
    [alertType, dedupKey]
  );
  return rows[0] || null;
}

// Distinct from findOpen — used only by the daily digest as a plain
// sent-marker (open or already resolved both count as "already sent
// today"), not as an ongoing condition to track.
async function existsAny(alertType, dedupKey) {
  const { rowCount } = await pool.query(
    `select 1 from alert_events where alert_type = $1 and dedup_key = $2 limit 1`,
    [alertType, dedupKey]
  );
  return rowCount > 0;
}

async function open({ alertType, dedupKey, severity, message, details }) {
  const { rows } = await pool.query(
    `insert into alert_events (alert_type, dedup_key, severity, message, details)
     values ($1, $2, $3, $4, $5) returning *`,
    [alertType, dedupKey, severity || 'warning', message, JSON.stringify(details || {})]
  );
  return rows[0];
}

async function touch(id) {
  await pool.query(`update alert_events set last_seen_at = now() where id = $1`, [id]);
}

async function markNotified(id) {
  await pool.query(`update alert_events set notified_at = now() where id = $1`, [id]);
}

async function resolveNow(id) {
  await pool.query(`update alert_events set resolved_at = now() where id = $1`, [id]);
}

// Resolves every OPEN alert of this type whose dedup_key isn't in this
// tick's detection set — the condition stopped reproducing. `= any('{}')`
// is false for every row, so an empty stillOpenDedupKeys array (nothing
// detected this tick) correctly resolves everything of this type that was
// open, not nothing.
async function resolveStale(alertType, stillOpenDedupKeys) {
  const { rows } = await pool.query(
    `update alert_events
     set resolved_at = now()
     where alert_type = $1 and resolved_at is null and not (dedup_key = any($2::text[]))
     returning *`,
    [alertType, stillOpenDedupKeys]
  );
  return rows;
}

async function listOpen() {
  const { rows } = await pool.query(
    `select * from alert_events where resolved_at is null order by first_detected_at asc`
  );
  return rows;
}

async function listResolvedSince(since) {
  const { rows } = await pool.query(
    `select * from alert_events where resolved_at >= $1 order by resolved_at asc`,
    [since]
  );
  return rows;
}

module.exports = { findOpen, existsAny, open, touch, markNotified, resolveNow, resolveStale, listOpen, listResolvedSince };
