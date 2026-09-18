// Layer 3 (the send probe) approved 2026-09-18, after validating by hand
// against both a known-good account (Fortune, 392608088696144: HTTP 404,
// code 132001) and the known-bad one (TNPSC, 894384560175844: HTTP 403,
// code 200). Fortune's response carried error_data.details — "template name
// (__wasi_sendability_probe__) does not exist in en_US" — exactly the kind
// of forensic detail that gets thrown away and then costs a day, per direct
// instruction. Deliberately its own migration, not folded into 074 — that
// schema was already agreed before this session's probe validation, and
// error_data is a Layer-3-specific need discovered afterward.
//
// Nullable, no backfill — same discipline as every other column in this
// feature (074_wabas_sendability.js).
exports.up = (pgm) => {
  pgm.addColumn('wabas', {
    sendable_error_data: { type: 'jsonb' },
  });
};

exports.down = async (pgm) => {
  const [{ count }] = await pgm.db.select(
    'select count(*)::int as count from wabas where sendable_error_data is not null'
  );
  if (count > 0) {
    throw new Error(`Cannot roll back 075_wabas_sendable_error_data: ${count} wabas row(s) have real sendable_error_data that would be lost.`);
  }
  pgm.dropColumn('wabas', 'sendable_error_data');
};
