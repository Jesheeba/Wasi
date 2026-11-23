// Ad lead feedback to Meta - Conversions API for Business Messaging
// (build-docs/features/ctwa-conversions.md).
//
// wabas.ctwa_dataset_id: the Meta dataset events are sent to, created once
// per WABA (POST /{WABA_ID}/dataset is idempotent). Read/written via
// wabasRepo on the privileged pool only, so the column-level wasi_app SELECT
// grant on wabas (013) needs no change.
//
// ctwa_conversions: one row per (chat, event) Wasi reported. Meta does not
// deduplicate these events, so the unique index is what stops a double
// count. Tenant table: wasi_app grant + RLS (same as 039/095/096/097).
exports.up = (pgm) => {
  pgm.addColumns('wabas', { ctwa_dataset_id: { type: 'text' } });

  pgm.createTable('ctwa_conversions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    chat_id: { type: 'uuid', notNull: true, references: 'chats', onDelete: 'CASCADE' },
    event_name: { type: 'text', notNull: true, check: "event_name in ('LeadSubmitted', 'Purchase')" },
    value: { type: 'numeric(12,2)' },
    currency: { type: 'text' },
    ctwa_clid: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('ctwa_conversions', ['chat_id', 'event_name'], { unique: true });
  pgm.createIndex('ctwa_conversions', 'client_id');

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql('grant select, insert, update, delete on ctwa_conversions to wasi_app');
  pgm.sql('alter table ctwa_conversions enable row level security');
  pgm.sql('alter table ctwa_conversions force row level security');
  pgm.sql(`create policy tenant_isolation on ctwa_conversions using (client_id = ${setting}) with check (client_id = ${setting})`);
};

// The events already live at Meta; dropping the local log only loses the
// duplicate guard and the "already reported" badge.
exports.down = (pgm) => {
  pgm.dropTable('ctwa_conversions');
  pgm.dropColumns('wabas', ['ctwa_dataset_id']);
};
