const { pool } = require('../db/pool');

async function incrementSent(clientId) {
  await pool.query(
    `insert into usage_logs (client_id, date, messages_sent)
     values ($1, current_date, 1)
     on conflict (client_id, date) do update set messages_sent = usage_logs.messages_sent + 1`,
    [clientId]
  );
}

async function incrementReceived(clientId) {
  await pool.query(
    `insert into usage_logs (client_id, date, messages_received)
     values ($1, current_date, 1)
     on conflict (client_id, date) do update set messages_received = usage_logs.messages_received + 1`,
    [clientId]
  );
}

// Approximates plan usage as total outbound messages this calendar month —
// a proxy for Meta's actual 24h "conversation" billing unit, which would
// need per-conversation-window tracking to compute exactly. Good enough to
// gate against a plan's conversation_limit without overbuilding this.
async function monthToDateSent(clientId) {
  const { rows } = await pool.query(
    `select coalesce(sum(messages_sent), 0)::int as total
     from usage_logs
     where client_id = $1 and date >= date_trunc('month', current_date)`,
    [clientId]
  );
  return rows[0].total;
}

module.exports = { incrementSent, incrementReceived, monthToDateSent };
