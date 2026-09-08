// PLAN.md item 12 — Smart Sending (spec §3.5/§10.1): skip a contact if
// they already received another broadcast within a configurable recent
// window. Nullable — null means disabled, same convention broadcasts.
// pacing_config already established for an opt-in per-broadcast knob.
exports.up = (pgm) => {
  pgm.addColumn('broadcasts', {
    smart_sending_hours: { type: 'integer' },
  });
};

exports.down = (pgm) => {
  // No live-row guard needed, unlike most of this plan's other columns —
  // this is a pure opt-in throttle knob (an integer read at send time),
  // not something any other row/table derives data from or references.
  // Dropping it just turns Smart Sending back off everywhere; it doesn't
  // lose or orphan anything.
  pgm.dropColumns('broadcasts', ['smart_sending_hours']);
};
