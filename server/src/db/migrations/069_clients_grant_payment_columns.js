// Same exact gap as migration 043_clients_grant_onboarding_columns.js,
// found the same way — reproduced live, not assumed: migration
// 068_client_payment_reminders.js added 6 columns to `clients` and
// clientsRepo.js's SAFE_COLUMNS was updated to select them, but nothing
// extended wasi_app's (migration 013_tenant_isolation.js) column-scoped
// SELECT grant to cover them. routes/onboarding.js's WhatsApp connect flow
// reads/writes the client row via req.db (the restricted wasi_app role,
// via withTenantContext) — confirmed to fail with "permission denied for
// table clients" the moment SAFE_COLUMNS included these new columns
// (server/test/onboardingServerSideDiscovery.test.js went from 7/7 to 5/7
// the moment 068 shipped, traced directly to this).
//
// UPDATE needs no equivalent fix, same reasoning 043 already documented:
// migration 013's UPDATE grant on `clients` is table-level, not
// column-scoped, so it already covers these columns automatically. Only
// column-level SELECT grants need updating explicitly per new column.
exports.up = (pgm) => {
  pgm.sql(`
    grant select (
      activated_at, payment_status, payment_marked_unpaid_at,
      payment_warning_sent_at, auto_suspended_for_nonpayment, last_reminder_sent_on
    )
    on clients to wasi_app
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    revoke select (
      activated_at, payment_status, payment_marked_unpaid_at,
      payment_warning_sent_at, auto_suspended_for_nonpayment, last_reminder_sent_on
    )
    on clients from wasi_app
  `);
};
