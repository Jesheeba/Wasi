const { pool } = require('../db/pool');

// The durable landing place consentRepo.recordOptOutDurable falls back to
// when even a retried consent write fails — see migration
// 078_failed_consent_writes.js's module comment. Always on the privileged
// pool: this exists specifically for the case where the ordinary write path
// is in trouble, so it must not depend on the same tenant connection that
// may itself be the problem.
async function record({ clientId, contactId, event, source, evidence, errorMessage }) {
  await pool.query(
    `insert into failed_consent_writes (client_id, contact_id, event, source, evidence, error_message)
     values ($1, $2, $3, $4, $5, $6)`,
    [clientId, contactId || null, event, source, evidence ? JSON.stringify(evidence) : null, errorMessage]
  );
}

// alertRunner.js's replayFailedConsentWrites reads every unresolved row each
// tick and retries it through consentRepo.recordEvent. Oldest first so a
// long-pending row (the one most overdue) gets retried before newer ones.
async function listPending() {
  const { rows } = await pool.query(
    `select * from failed_consent_writes where resolved_at is null order by created_at asc`
  );
  return rows;
}

// Used by alertRunner.js's checkPendingFailedConsentWrites — the count
// alone (not the rows) is enough to decide whether the ongoing alert should
// still be open.
async function countPending() {
  const { rows } = await pool.query(
    `select count(*)::int as count from failed_consent_writes where resolved_at is null`
  );
  return rows[0].count;
}

async function resolve(id) {
  await pool.query(`update failed_consent_writes set resolved_at = now() where id = $1`, [id]);
}

module.exports = { record, listPending, countPending, resolve };
