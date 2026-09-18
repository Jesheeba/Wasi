// Sendability monitoring. Built after a real 26-hour undetected outage
// (TNPSC Mentors, 2026-09-18) whose actual cause — a credit line still
// belonging to the client's previous BSP — no Meta API field reports to us
// directly. Three layers, three groups of columns below:
//
// 1. REGISTRATION (raw fields only, own columns, no verdict) — is_on_biz_app
//    === false AND code_verification_status !== 'VERIFIED' was floated as a
//    "definitely can't send" rule, but it is an unconfirmed hypothesis, not
//    a proven one (TNPSC registered successfully and code_verification_status
//    stayed EXPIRED regardless — whether that field blocks anything at all is
//    unknown). It must not be able to set `sendable` on its own, so it gets
//    its own columns instead of writing into the verdict.
// 2. HEALTH_STATUS (raw, informational) — verified NOT to catch the billing
//    case (returned AVAILABLE for every entity on TNPSC while sends failed),
//    so it's stored for its own real value (e.g. catching a BUSINESS-level
//    verification problem) and never feeds `sendable` either.
// 3. SENDABLE (the verdict) — written ONLY by the send probe (Layer 3, a
//    separate approval, not yet built as of this migration). Verified by
//    hand against both a known-good and known-known-bad account before this
//    schema was finalized: healthy -> HTTP 404 / (#132001) template not
//    found; blocked -> HTTP 403 / (#200) OAuthException permission denied.
//
// Nullable, no backfill, no default — "never checked yet" must stay
// distinguishable from every real outcome, same discipline as
// messaging_tier/messaging_tier_checked_at (migration 064/070) and
// delivered_at/read_at/failed_at (migration 072).
exports.up = (pgm) => {
  pgm.addColumns('wabas', {
    // Layer 1 — registration, raw Meta fields, no derived verdict.
    registration_is_on_biz_app: { type: 'boolean' },
    registration_code_verification_status: { type: 'text' },
    registration_platform_type: { type: 'text' },
    // Named registration_phone_status, not `status` — wabas.status already
    // means Wasi's own connection-state enum (connecting/connected/
    // needs_manual_resolution/failed/incomplete_meta_linked); this is Meta's
    // own phone-number-resource `status` field, a different thing entirely.
    registration_phone_status: { type: 'text' },
    registration_checked_at: { type: 'timestamptz' },

    // Layer 2 — health_status, raw per-entity payload from Meta
    // (GET /{phone_number_id}?fields=health_status): {entities:[{entity_type,
    // can_send_message, errors:[{error_code, error_description,
    // possible_solution}]}]}. Structurally variable (entity list, error
    // shape) — jsonb, same precedent as connect_diagnostics
    // (055_wabas_connect_diagnostics.js), never queried/branched on in SQL.
    health_status: { type: 'jsonb' },
    health_status_checked_at: { type: 'timestamptz' },

    // Layer 3 — the sendability verdict itself. Written ONLY by the send
    // probe once built — see this file's own header comment. sendable_reason
    // and sendable_error_code are populated whenever sendable is false OR
    // when a probe response couldn't be classified into either known shape
    // (sendable stays null in that case too — never guessed either way).
    sendable: { type: 'boolean' },
    sendable_checked_at: { type: 'timestamptz' },
    sendable_reason: { type: 'text' },
    sendable_error_code: { type: 'integer' },
  });
};

exports.down = async (pgm) => {
  const [{ count }] = await pgm.db.select(`
    select count(*)::int as count from wabas
    where registration_checked_at is not null
       or health_status_checked_at is not null
       or sendable_checked_at is not null
  `);
  if (count > 0) {
    throw new Error(`Cannot roll back 074_wabas_sendability: ${count} wabas row(s) have real sendability-monitoring data that would be lost.`);
  }
  pgm.dropColumns('wabas', [
    'registration_is_on_biz_app', 'registration_code_verification_status',
    'registration_platform_type', 'registration_phone_status', 'registration_checked_at',
    'health_status', 'health_status_checked_at',
    'sendable', 'sendable_checked_at', 'sendable_reason', 'sendable_error_code',
  ]);
};
