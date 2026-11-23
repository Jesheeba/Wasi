// Forms with live data: booking with real free slots
// (build-docs/features/whatsapp-flows.md, "Phase 2: live booking").
//
// wabas.flows_private_key_encrypted / flows_key_uploaded_at: the RSA key pair
// Meta uses to encrypt calls to Wasi's Flows endpoint. The public half is
// uploaded to Meta (POST /{PHONE_ID}/whatsapp_business_encryption); the
// private half is stored encrypted with utils/encryption.js. Read/written via
// wabasRepo on the privileged pool only (wasi_app column grant on wabas
// unaffected).
//
// whatsapp_flows.kind gains 'booking_live'.
//
// whatsapp_flow_bookings: one row per booked slot. Tenant table: wasi_app
// grant + RLS. The endpoint writes on the privileged pool, scoped by
// client_id, and enforces each slot's capacity inside a transaction.
exports.up = (pgm) => {
  pgm.addColumns('wabas', {
    flows_private_key_encrypted: { type: 'text' },
    flows_key_uploaded_at: { type: 'timestamptz' },
  });

  pgm.dropConstraint('whatsapp_flows', 'whatsapp_flows_kind_check', { ifExists: true });
  pgm.addConstraint('whatsapp_flows', 'whatsapp_flows_kind_check', { check: "kind in ('lead', 'booking', 'survey', 'booking_live')" });

  pgm.createTable('whatsapp_flow_bookings', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    flow_id: { type: 'uuid', notNull: true, references: 'whatsapp_flows', onDelete: 'CASCADE' },
    chat_id: { type: 'uuid', references: 'chats', onDelete: 'SET NULL' },
    slot_date: { type: 'date', notNull: true },
    slot_time: { type: 'text', notNull: true },
    name: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'booked', check: "status in ('booked', 'cancelled')" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('whatsapp_flow_bookings', ['flow_id', 'slot_date', 'slot_time']);
  pgm.createIndex('whatsapp_flow_bookings', ['client_id', 'slot_date']);

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql('grant select, insert, update, delete on whatsapp_flow_bookings to wasi_app');
  pgm.sql('alter table whatsapp_flow_bookings enable row level security');
  pgm.sql('alter table whatsapp_flow_bookings force row level security');
  pgm.sql(`create policy tenant_isolation on whatsapp_flow_bookings using (client_id = ${setting}) with check (client_id = ${setting})`);
};

// Real bookings could exist: refuse with the count instead of dropping them.
exports.down = async (pgm) => {
  const [{ count }] = await pgm.db.select('select count(*)::int as count from whatsapp_flow_bookings');
  if (count > 0) throw new Error(`Cannot roll back 101_flow_live_booking: ${count} booking(s) exist.`);
  pgm.dropTable('whatsapp_flow_bookings');
  pgm.dropConstraint('whatsapp_flows', 'whatsapp_flows_kind_check');
  pgm.addConstraint('whatsapp_flows', 'whatsapp_flows_kind_check', { check: "kind in ('lead', 'booking', 'survey')" });
  pgm.dropColumns('wabas', ['flows_private_key_encrypted', 'flows_key_uploaded_at']);
};
