// Meta analytics (build-docs/features/meta-analytics.md).
// wabas.template_insights_enabled_at: when the client switched on Meta's
// template analytics for this WABA (POST /{WABA_ID} is_enabled_for_insights).
// Meta says that switch cannot be turned off, so Wasi records who-knows-when
// rather than re-asking Meta. Nullable, no backfill (null = never enabled
// through Wasi).
//
// Read and written only through wabasRepo on the privileged pool, so the
// column-level wasi_app SELECT grant on wabas (migration 013) does not need
// extending - nothing reads this column via req.db.
exports.up = (pgm) => {
  pgm.addColumns('wabas', { template_insights_enabled_at: { type: 'timestamptz' } });
};

// A timestamp only; Meta keeps insights on regardless.
exports.down = (pgm) => {
  pgm.dropColumns('wabas', ['template_insights_enabled_at']);
};
