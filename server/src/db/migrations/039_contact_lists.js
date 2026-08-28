// Broadcast/Campaign Engine (wasi-master-plan.md §8.3) — this migration
// does NOT build a broadcast engine from scratch: broadcasts,
// broadcast_recipients, and a working background runner
// (services/broadcastRunner.js) already exist and already reuse the real
// hardened send path (messagingService.sendChatMessage). What's missing per
// §6.B is CSV-importable, reusable audience targeting beyond the existing
// single contacts.tag_id filter, and a per-broadcast pacing knob — both
// added here, additively, alongside the existing tag_id mechanism (Phase 0
// decision: add, don't replace — existing tag-based campaigns and their
// data are untouched).
//
// contact_lists/contact_list_members are genuinely new tenant tables (same
// RLS treatment as every tenant table since 013_tenant_isolation.js).
// contact_list_members has a real unique(contact_list_id, contact_id)
// constraint — CSV import re-runs (e.g. uploading an updated export) must
// be able to upsert without erroring or duplicating membership rows.
//
// broadcasts.contact_list_id is nullable and mutually exclusive with the
// existing tag_id (CHECK below) — a broadcast targets its audience via
// EXACTLY ONE mechanism, never both at once (ambiguous), and both null
// still means "everyone" exactly as today (createFromAudience's existing
// null-tag_id behavior, unchanged).
//
// broadcasts.pacing_config is nullable jsonb, e.g. {"messages_per_minute": 60}
// — absent means "use the runner's existing BATCH_SIZE/SEND_CONCURRENCY
// defaults unchanged," so every broadcast created before this migration
// keeps its exact current behavior. Real Meta numbers this default is
// weighed against (fetched live from developers.facebook.com during Phase 3
// planning, not assumed): Cloud API throughput defaults to 80 messages/
// second per business phone number; the 24h messaging-tier caps are
// 250 -> 2,000 -> 10,000 -> 100,000 -> Unlimited unique conversations,
// applied at the business-portfolio level since Oct 2025. Real-time
// enforcement of the tier cap itself is explicitly deferred (would need a
// new Graph API integration to query a WABA's current tier — real new
// infrastructure, not a reuse of Phase 1's rate-limit work) — pacing_config
// only controls this app's own send throughput, which stays far under the
// 80 MPS throughput ceiling regardless of configured value (capped at 300/min
// = 5/sec, see broadcastCreateSchema).
exports.up = (pgm) => {
  pgm.createTable('contact_lists', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    source: { type: 'text', notNull: true, default: 'csv_import', check: "source in ('csv_import', 'manual')" },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('contact_lists', 'client_id');

  pgm.createTable('contact_list_members', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    contact_list_id: { type: 'uuid', notNull: true, references: 'contact_lists', onDelete: 'CASCADE' },
    contact_id: { type: 'uuid', notNull: true, references: 'contacts', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('contact_list_members', 'contact_list_id');
  pgm.addConstraint('contact_list_members', 'contact_list_members_unique_member', {
    unique: ['contact_list_id', 'contact_id'],
  });

  pgm.addColumns('broadcasts', {
    contact_list_id: { type: 'uuid', references: 'contact_lists', onDelete: 'SET NULL' },
    pacing_config: { type: 'jsonb' },
  });
  pgm.addConstraint('broadcasts', 'broadcasts_audience_not_both', {
    check: 'tag_id is null or contact_list_id is null',
  });

  const NEW_TENANT_TABLES = ['contact_lists', 'contact_list_members'];
  for (const table of NEW_TENANT_TABLES) {
    pgm.sql(`grant select, insert, update, delete on ${table} to wasi_app`);
  }
  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  pgm.sql(`alter table contact_lists enable row level security`);
  pgm.sql(`alter table contact_lists force row level security`);
  pgm.sql(`create policy tenant_isolation on contact_lists using (client_id = ${setting}) with check (client_id = ${setting})`);

  // contact_list_members has no client_id of its own (reachable only via
  // contact_list_id -> contact_lists.client_id) — same shape
  // broadcast_recipients started in before migration 013 added it a
  // dedicated column. A join-based policy is correct and sufficient here
  // since this table is never queried on the privileged connection the way
  // broadcast_recipients is by broadcastRunner (list membership is only
  // ever read/written via the owning client's own req.db).
  pgm.sql(`alter table contact_list_members enable row level security`);
  pgm.sql(`alter table contact_list_members force row level security`);
  pgm.sql(`
    create policy tenant_isolation on contact_list_members
      using (contact_list_id in (select id from contact_lists where client_id = ${setting}))
      with check (contact_list_id in (select id from contact_lists where client_id = ${setting}))
  `);
};

exports.down = async (pgm) => {
  // Same discipline as migrations 032 and 036's down()s: real client data
  // (uploaded contact lists) could exist by the time a rollback runs on
  // this shared database. Check first, fail loudly with the count.
  const [{ count }] = await pgm.db.select('select count(*)::int as count from contact_lists');
  if (count > 0) {
    throw new Error(
      `Cannot roll back 039_contact_lists: contact_lists has ${count} real row(s) of ` +
      `client-uploaded audience data. Export/back up this data first if it needs to be kept, ` +
      `then retry this rollback.`
    );
  }

  pgm.dropConstraint('broadcasts', 'broadcasts_audience_not_both');
  pgm.dropColumns('broadcasts', ['contact_list_id', 'pacing_config']);

  pgm.sql('drop policy if exists tenant_isolation on contact_list_members');
  pgm.sql('alter table contact_list_members disable row level security');
  pgm.dropTable('contact_list_members');

  pgm.sql('drop policy if exists tenant_isolation on contact_lists');
  pgm.sql('alter table contact_lists disable row level security');
  pgm.dropTable('contact_lists');
};
