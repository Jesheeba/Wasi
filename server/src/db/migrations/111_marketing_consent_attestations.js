// Account-level marketing consent attestation (build-docs/features/
// marketing-consent-attestation.md). Append-only: the latest row per client
// is the current state, every earlier row is the history. Tenant-scoped
// (the client's own Settings screen reads and writes it through req.db), so
// it gets the wasi_app grant + tenant_isolation RLS policy like migration
// 103's tables - but select/insert only, never update/delete, so the
// history cannot be rewritten through the app role.

exports.up = (pgm) => {
  pgm.createTable('marketing_consent_attestations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_id: { type: 'uuid', notNull: true, references: 'clients', onDelete: 'CASCADE' },
    event: { type: 'text', notNull: true, check: "event in ('attested', 'withdrawn')" },
    statement_version: { type: 'text', notNull: true },
    statement_text: { type: 'text', notNull: true },
    actor_type: { type: 'text', notNull: true, check: "actor_type in ('owner', 'team_member')" },
    actor_id: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('marketing_consent_attestations', ['client_id', { name: 'created_at', sort: 'DESC' }]);

  const setting = "nullif(current_setting('app.current_client_id', true), '')::uuid";
  pgm.sql('grant select, insert on marketing_consent_attestations to wasi_app');
  pgm.sql('alter table marketing_consent_attestations enable row level security');
  pgm.sql('alter table marketing_consent_attestations force row level security');
  pgm.sql(`create policy tenant_isolation on marketing_consent_attestations using (client_id = ${setting}) with check (client_id = ${setting})`);
};

// The rows are a legal record of what a client agreed to; refuse to drop
// them once any exist.
exports.down = (pgm) => {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from marketing_consent_attestations) then
        raise exception 'Refusing to roll back 111_marketing_consent_attestations: attestation history exists.';
      end if;
    end $$;
  `);
  pgm.dropTable('marketing_consent_attestations');
};
