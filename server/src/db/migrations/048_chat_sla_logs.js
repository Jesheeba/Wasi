// PLAN.md item 5 — SLA / First Response Time tracking. One row per
// (chat, triggering inbound message) — first_response_seconds and
// resolved_seconds are both measured from that SAME inbound's arrival, not
// from each other, so a resolved chat that never got a tracked first reply
// (an agent silently resolves without responding) still gets a real
// resolution-latency row, and a first response that never gets resolved
// still gets a real FRT row — the two are independently nullable on the
// same row rather than forcing one to exist before the other can.
//
// inbound_message_id is nullable (ON DELETE SET NULL) for the same reason
// team_member_id is: a message row deleted later shouldn't take real
// historical SLA data with it, only its own attribution.
//
// The partial unique index (WHERE inbound_message_id IS NOT NULL) is what
// item 5's dedup mechanism relies on: item 2's reopen-on-inbound gives each
// answer/resolve cycle for a chat its own distinct inbound_message_id, so
// this naturally allows exactly one first-response/resolution pair per
// cycle without needing a separate "cycle number" column.
exports.up = (pgm) => {
  pgm.createTable('chat_sla_logs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    chat_id: { type: 'uuid', notNull: true, references: 'chats', onDelete: 'CASCADE' },
    team_member_id: { type: 'uuid', references: 'team_members', onDelete: 'SET NULL' },
    inbound_message_id: { type: 'uuid', references: 'messages', onDelete: 'SET NULL' },
    first_response_seconds: { type: 'integer' },
    resolved_seconds: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('chat_sla_logs', 'client_id');
  pgm.createIndex('chat_sla_logs', 'chat_id');
  pgm.sql(`
    create unique index chat_sla_logs_one_per_inbound
      on chat_sla_logs (chat_id, inbound_message_id)
      where inbound_message_id is not null
  `);

  pgm.sql(`grant select, insert, update, delete on chat_sla_logs to wasi_app`);

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql(`alter table chat_sla_logs enable row level security`);
  pgm.sql(`alter table chat_sla_logs force row level security`);
  pgm.sql(`
    create policy tenant_isolation on chat_sla_logs
      using (client_id = ${setting})
      with check (client_id = ${setting})
  `);
};

exports.down = async (pgm) => {
  // Same discipline as every other tenant-table down() in this plan — real
  // historical agent-performance data could exist by the time a rollback
  // runs on this shared database.
  const [{ count }] = await pgm.db.select('select count(*)::int as count from chat_sla_logs');
  if (count > 0) {
    throw new Error(
      `Cannot roll back 048_chat_sla_logs: ${count} real SLA record(s) exist. ` +
      `Export/back up first if they need to be kept, then retry this rollback.`
    );
  }

  pgm.sql(`drop policy if exists tenant_isolation on chat_sla_logs`);
  pgm.sql(`alter table chat_sla_logs disable row level security`);
  pgm.sql(`revoke all on chat_sla_logs from wasi_app`);
  pgm.sql(`drop index if exists chat_sla_logs_one_per_inbound`);
  pgm.dropTable('chat_sla_logs');
};
