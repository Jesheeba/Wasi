const { pool } = require('../db/pool');

async function list() {
  const { rows } = await pool.query('select * from payment_reminder_schedules order by day_of_month, send_hour');
  return rows;
}

async function listEnabled() {
  const { rows } = await pool.query('select * from payment_reminder_schedules where enabled order by day_of_month, send_hour');
  return rows;
}

async function create({ day_of_month, send_hour, created_by }) {
  const { rows } = await pool.query(
    'insert into payment_reminder_schedules (day_of_month, send_hour, created_by) values ($1, $2, $3) returning *',
    [day_of_month, send_hour, created_by || null]
  );
  return rows[0];
}

async function setEnabled(id, enabled) {
  const { rows } = await pool.query('update payment_reminder_schedules set enabled = $2 where id = $1 returning *', [id, enabled]);
  return rows[0] || null;
}

async function remove(id) {
  const { rowCount } = await pool.query('delete from payment_reminder_schedules where id = $1', [id]);
  return rowCount > 0;
}

// Atomic once-per-day claim. Returns the row only for the caller that wins;
// a second tick/instance on the same date gets null and must not send.
// Claimed BEFORE sending (at-most-once): a crash mid-send skips the rest of
// that day's run rather than risking a double reminder.
async function claimForDate(id, dateString) {
  const { rows } = await pool.query(
    `update payment_reminder_schedules set last_run_on = $2::date
     where id = $1 and enabled and (last_run_on is null or last_run_on < $2::date) returning *`,
    [id, dateString]
  );
  return rows[0] || null;
}

async function recordSummary(id, summary) {
  await pool.query('update payment_reminder_schedules set last_run_summary = $2 where id = $1', [id, summary]);
}

module.exports = { list, listEnabled, create, setEnabled, remove, claimForDate, recordSummary };
