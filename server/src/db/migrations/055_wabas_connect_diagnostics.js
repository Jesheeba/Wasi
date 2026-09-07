// PLAN.md item 25, Part A — server-side WABA/phone discovery. Pure additive
// diagnostic column: stores the raw discovery outcome (candidate WABA
// target_ids from debug_token's granular_scopes, candidate phone numbers,
// and which branch was taken — auto-resolved vs. ambiguous) so admin/support
// can see *why* a connect attempt landed where it did, matching this
// codebase's existing precedent of capturing raw diagnostic payloads
// (metaWebhook.js's handleUnmappedWabaEvent). Not required for the discovery
// mechanism itself to function — a debugging aid only.
//
// No grant extension needed: wabasRepo.js never runs on the restricted
// wasi_app role (see that file's own module comment) — every wabas read/
// write in this app already goes through the privileged pool, so a new
// column here is never blocked by wasi_app's column-scoped SELECT grant the
// way clients' onboarding columns were (migration 043).
exports.up = (pgm) => {
  pgm.addColumn('wabas', {
    connect_diagnostics: { type: 'jsonb' },
  });
};

exports.down = async (pgm) => {
  // Live-row guard, matching migrations 032/036/039's discipline — once
  // populated, this is real diagnostic history for a live client's
  // connection attempt, not disposable.
  const [{ count }] = await pgm.db.select('select count(*)::int as count from wabas where connect_diagnostics is not null');
  if (count > 0) {
    throw new Error(
      `Cannot roll back 055_wabas_connect_diagnostics: wabas has ${count} row(s) with real ` +
      `discovery diagnostic data. Back this up first if it needs to be kept, then retry this rollback.`
    );
  }
  pgm.dropColumn('wabas', 'connect_diagnostics');
};
