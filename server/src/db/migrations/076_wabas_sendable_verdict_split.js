// Two honest signals instead of one confident-sounding wrong one. Found live
// 2026-09-18, first real check cycle after Layer 3 deployed: three WABAs
// (GV Mart 109558648723856, Brainlit 918537580543018, RD Interlock Bricks
// 463815720015046) came back sendable:true from the probe alone while
// Meta's health_status reported them BLOCKED with 141006 (a payment-method
// error) — the probe tests PERMISSION, not overall sendability, and a green
// "sendable" badge on those three would have been actively misleading (they
// cannot run a campaign today).
//
// Renames the 074/075 probe-only columns to say what they actually measure
// (data preserved, not dropped), then reclaims the `sendable` name for a
// genuinely combined verdict: sendable only if the probe passes AND no
// health_status entity is BLOCKED. The short, obvious name stays reserved
// for the signal people should actually trust without reading the fine
// print — see sendabilityMonitorRunner.js's computeSendableVerdict for the
// exact logic.
exports.up = (pgm) => {
  pgm.renameColumn('wabas', 'sendable', 'probe_sendable');
  pgm.renameColumn('wabas', 'sendable_reason', 'probe_reason');
  pgm.renameColumn('wabas', 'sendable_error_code', 'probe_error_code');
  pgm.renameColumn('wabas', 'sendable_error_data', 'probe_error_data');
  pgm.renameColumn('wabas', 'sendable_checked_at', 'probe_checked_at');

  pgm.addColumns('wabas', {
    sendable: { type: 'boolean' },
    sendable_reason: { type: 'text' },
    sendable_checked_at: { type: 'timestamptz' },
  });
};

exports.down = async (pgm) => {
  const [{ count }] = await pgm.db.select(
    'select count(*)::int as count from wabas where sendable_checked_at is not null'
  );
  if (count > 0) {
    throw new Error(`Cannot roll back 076_wabas_sendable_verdict_split: ${count} wabas row(s) have a real combined sendable verdict that would be lost.`);
  }
  pgm.dropColumns('wabas', ['sendable', 'sendable_reason', 'sendable_checked_at']);
  pgm.renameColumn('wabas', 'probe_sendable', 'sendable');
  pgm.renameColumn('wabas', 'probe_reason', 'sendable_reason');
  pgm.renameColumn('wabas', 'probe_error_code', 'sendable_error_code');
  pgm.renameColumn('wabas', 'probe_error_data', 'sendable_error_data');
  pgm.renameColumn('wabas', 'probe_checked_at', 'sendable_checked_at');
};
