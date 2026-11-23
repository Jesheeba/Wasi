// WhatsApp quick wins (build-docs/features/whatsapp-quick-wins.md).
//
// contacts.whatsapp_blocked_at: set when the business blocks the contact on
// WhatsApp (block_users), cleared on unblock. Nullable, no backfill: null is
// "not blocked", the right state for every existing contact. `contacts` has a
// table-level wasi_app grant (013), so no grant change is needed.
//
// whatsapp_qr_codes: Meta returns a QR code's image URL only in the create
// response, so Wasi keeps its own copy of each code it created. Tenant table:
// wasi_app grant + RLS, same as 039/095/096.
exports.up = (pgm) => {
  pgm.addColumns('contacts', { whatsapp_blocked_at: { type: 'timestamptz' } });

  pgm.createTable('whatsapp_qr_codes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    code: { type: 'text', notNull: true },
    prefilled_message: { type: 'text', notNull: true },
    deep_link_url: { type: 'text', notNull: true },
    qr_image_url: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('whatsapp_qr_codes', ['client_id', 'code'], { unique: true });

  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql('grant select, insert, update, delete on whatsapp_qr_codes to wasi_app');
  pgm.sql('alter table whatsapp_qr_codes enable row level security');
  pgm.sql('alter table whatsapp_qr_codes force row level security');
  pgm.sql(`create policy tenant_isolation on whatsapp_qr_codes using (client_id = ${setting}) with check (client_id = ${setting})`);
};

// The QR codes live on Meta too; dropping the local copy loses only the image
// URLs. The blocked flag is display state (Meta holds the real block list).
exports.down = (pgm) => {
  pgm.dropTable('whatsapp_qr_codes');
  pgm.dropColumns('contacts', ['whatsapp_blocked_at']);
};
