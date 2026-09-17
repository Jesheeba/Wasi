// Real-time messaging-tier detection (broadcast preflight warning feature).
// wabas.messaging_tier (migration 064) already exists but has never been
// populated — this adds the one companion column that was missing to make
// it useful: when it was last actually checked against Meta, so a stale
// value can be told apart from a fresh one and messagingTierRefreshRunner.js
// knows what's due for a re-check.
exports.up = (pgm) => {
  pgm.addColumn('wabas', {
    messaging_tier_checked_at: { type: 'timestamptz' },
  });
};

exports.down = async (pgm) => {
  // Live-row guard, same precedent as 055_wabas_connect_diagnostics.js's
  // down() — this column is populated by real fetches from the moment this
  // migration ships (unlike 064's own column, which stayed unpopulated by
  // design until this migration's fetch code existed), so dropping it
  // without checking would silently discard real data.
  const [{ count }] = await pgm.db.select('select count(*)::int as count from wabas where messaging_tier_checked_at is not null');
  if (count > 0) {
    throw new Error(`Cannot roll back 070_wabas_messaging_tier_checked_at: wabas has ${count} row(s) with a real messaging_tier_checked_at value that would be lost.`);
  }
  pgm.dropColumn('wabas', 'messaging_tier_checked_at');
};
