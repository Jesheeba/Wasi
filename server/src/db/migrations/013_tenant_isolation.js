// Database-level tenant isolation (build plan Phase 3). Until now, tenant
// separation relied entirely on every query including `where client_id = $1`
// — one query written without it exposes one client's data to another, and
// nothing catches it. This moves enforcement into Postgres so the guarantee
// stops depending on application code being perfect.
//
// Investigated before writing this (see wasi-build-plan.md Phase 3 / the
// conversation this migration came out of) — the load-bearing finding: the
// app's DATABASE_URL connects as Supabase's `postgres` role, which has
// rolbypassrls = true (confirmed live via `select rolbypassrls from pg_roles
// where rolname = current_user`). Enabling RLS alone would be a complete
// no-op for that connection — every query would keep seeing every tenant's
// rows, silently. So this migration also provisions a second, restricted
// role (`wasi_app`, NOLOGIN, NOBYPASSRLS) that ordinary client-authenticated
// request traffic runs as (via `SET LOCAL ROLE` inside a request-scoped
// transaction — see server/src/middleware/tenantContext.js), while the
// existing `postgres` connection keeps its privileged, cross-tenant access
// for admin routes, the webhook receiver, the broadcast runner, seed data,
// and migrations. `wasi_app` is NOLOGIN because nothing connects to Postgres
// directly as it — the app's single pooled connection switches into it
// per-transaction via SET LOCAL ROLE, which only works if the connecting
// role (postgres) is a member of it.
//
// broadcast_recipients has no client_id column today (only reachable via
// broadcast_id -> broadcasts.client_id) — added here so it gets the same
// direct, indexable policy as every other tenant table instead of being a
// join-dependent special case.
//
// wabas and clients are NOT granted to wasi_app for SELECT/UPDATE beyond
// what's below and are not routed through it anywhere in the app today
// (see server/src/repositories/wabasRepo.js's and clientsRepo.js's module
// comments) — wabas.access_token_encrypted specifically must never be
// readable by the restricted role (mirrors Sirah CRM's approach), and since
// column-level SELECT can't be "partially" satisfied by a `select *` query,
// every wabas read stays on the privileged connection rather than
// special-casing column lists per call site. RLS is still enabled on both
// so a future engineer who mistakenly wires either table through the
// restricted role gets a privilege-denied error, not a silent leak.

const TENANT_TABLES = [
  'subscriptions',
  'message_templates',
  'usage_logs',
  'tags',
  'contacts',
  'chats',
  'messages',
  'broadcasts',
  'automation_rules',
  'support_tickets',
  'invoices',
  'consent_events',
  'team_members',
  'contact_attributes',
  'payment_links',
  'wallet_transactions',
  'client_webhooks',
  'broadcast_recipients',
];

exports.up = (pgm) => {
  // --- broadcast_recipients gets a real client_id column ---
  pgm.addColumn('broadcast_recipients', {
    client_id: { type: 'uuid', references: 'clients', onDelete: 'CASCADE' },
  });
  pgm.sql(`
    update broadcast_recipients br
    set client_id = b.client_id
    from broadcasts b
    where b.id = br.broadcast_id
  `);
  pgm.alterColumn('broadcast_recipients', 'client_id', { notNull: true });
  pgm.createIndex('broadcast_recipients', 'client_id');

  // --- restricted role ---
  pgm.sql(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'wasi_app') then
        create role wasi_app nologin nobypassrls;
      end if;
    end
    $$;
  `);
  // Lets the connecting role (postgres) SET LOCAL ROLE wasi_app — Postgres
  // requires membership to switch into a role, even for its own creator.
  pgm.sql(`grant wasi_app to current_user`);
  pgm.sql(`grant usage on schema public to wasi_app`);

  // --- table grants: the 18 tables with a direct client_id column ---
  for (const table of TENANT_TABLES) {
    pgm.sql(`grant select, insert, update, delete on ${table} to wasi_app`);
  }

  // plans: global reference data, no client_id, no RLS — read-only grant.
  pgm.sql(`grant select on plans to wasi_app`);

  // clients: the tenant table itself. Policy is keyed on id, not client_id.
  // password_hash is excluded from both the grant and (see repositories/
  // clientsRepo.js) every query text that could run under this role — the
  // column-level revoke below is belt-and-suspenders, not the only guard.
  pgm.sql(`
    grant select (id, name, email, status, tenant_slug, email_verified, created_at), update, delete
    on clients to wasi_app
  `);
  pgm.sql(`revoke select (password_hash) on clients from wasi_app`);

  // wabas: granted for defense-in-depth (see module comment above) even
  // though nothing in the app routes wabas access through wasi_app today.
  pgm.sql(`
    grant select (id, client_id, waba_id, phone_number_id, display_name, quality_rating, verified_at, status, created_at), insert, update, delete
    on wabas to wasi_app
  `);
  pgm.sql(`revoke select (access_token_encrypted) on wabas from wasi_app`);

  // --- RLS ---
  // nullif(..., '') matters, not just style: the first time a session ever
  // runs SET LOCAL on a custom (unregistered) GUC like app.current_client_id,
  // Postgres creates a session-local placeholder for it — and once that
  // placeholder exists, current_setting(..., true) returns '' (empty
  // string) after the transaction that set it ends, not NULL, even though
  // nothing is "set" from the app's point of view. On a pooled connection
  // reused across requests, any later query that (by mistake) runs without
  // calling set_config first would hit ''::uuid, which raises a Postgres
  // error ("invalid input syntax for type uuid") instead of cleanly
  // matching no rows. nullif converts that '' to NULL first, so the cast
  // succeeds, the comparison evaluates to NULL (not true), and the policy
  // fails closed — 0 rows, no error — the same way it does when the GUC
  // has genuinely never been touched in the session.
  const setting = `nullif(current_setting('app.current_client_id', true), '')::uuid`;
  for (const table of TENANT_TABLES) {
    pgm.sql(`alter table ${table} enable row level security`);
    pgm.sql(`alter table ${table} force row level security`);
    pgm.sql(`
      create policy tenant_isolation on ${table}
        using (client_id = ${setting})
        with check (client_id = ${setting})
    `);
  }

  pgm.sql(`alter table clients enable row level security`);
  pgm.sql(`alter table clients force row level security`);
  pgm.sql(`
    create policy tenant_isolation on clients
      using (id = ${setting})
      with check (id = ${setting})
  `);

  pgm.sql(`alter table wabas enable row level security`);
  pgm.sql(`alter table wabas force row level security`);
  pgm.sql(`
    create policy tenant_isolation on wabas
      using (client_id = ${setting})
      with check (client_id = ${setting})
  `);
};

exports.down = (pgm) => {
  pgm.sql(`drop policy if exists tenant_isolation on wabas`);
  pgm.sql(`alter table wabas disable row level security`);

  pgm.sql(`drop policy if exists tenant_isolation on clients`);
  pgm.sql(`alter table clients disable row level security`);

  for (const table of [...TENANT_TABLES].reverse()) {
    pgm.sql(`drop policy if exists tenant_isolation on ${table}`);
    pgm.sql(`alter table ${table} disable row level security`);
  }

  pgm.sql(`revoke all on wabas from wasi_app`);
  pgm.sql(`revoke all on clients from wasi_app`);
  pgm.sql(`revoke all on plans from wasi_app`);
  for (const table of TENANT_TABLES) {
    pgm.sql(`revoke all on ${table} from wasi_app`);
  }
  pgm.sql(`revoke usage on schema public from wasi_app`);
  pgm.sql(`drop role if exists wasi_app`);

  pgm.dropIndex('broadcast_recipients', 'client_id');
  pgm.dropColumn('broadcast_recipients', 'client_id');
};
