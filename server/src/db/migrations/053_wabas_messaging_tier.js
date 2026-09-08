// PLAN.md item 13 — messaging tier tracking, migration only (per explicit
// instruction: no Graph API field name has been confirmed against a live
// connected WABA, and the reference spec doesn't give a verified one
// either — do not guess). No fetch code is written in this pass; see the
// TODO added in alertRunner.js for the follow-up work this unblocks.
//
// Checked for the same class of gap CLAUDE.md documents for
// clients (migration 043 — a wasi_app column-level SELECT grant that
// never got extended when new columns were added): does NOT apply here.
// wabasRepo.js's own header comment confirms every `wabas` read/write in
// the app deliberately stays on the privileged `pool` connection, never
// req.db/wasi_app, specifically because access_token_encrypted is already
// column-revoked from that role, making any `select *` under it error
// regardless of which other columns exist. Adding a column here needs no
// grant extension.
exports.up = (pgm) => {
  pgm.addColumn('wabas', {
    messaging_tier: { type: 'text' },
  });
};

exports.down = (pgm) => {
  // No live-row guard needed — this column is added unpopulated and stays
  // that way until the TODO'd fetch work lands, so there is nothing real
  // to lose by dropping it.
  pgm.dropColumns('wabas', ['messaging_tier']);
};
