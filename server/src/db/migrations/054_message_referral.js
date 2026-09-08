// PLAN.md item 14 — CTWA (Click-to-WhatsApp ad) referral capture. When an
// inbound message carries Meta's documented `referral` object (the ad-click
// origin — §6.2), store it verbatim: source_url, source_type, source_id,
// headline, body, media_type, image_url/video_url, ctwa_clid. Nullable —
// most inbound messages have no referral at all (organic contact, not from
// an ad click).
exports.up = (pgm) => {
  pgm.addColumn('messages', {
    referral: { type: 'jsonb' },
  });
};

exports.down = async (pgm) => {
  // Real ad-attribution data once live CTWA traffic exists — same live-row
  // guard discipline as every other migration in this plan.
  const [{ count }] = await pgm.db.select('select count(*)::int as count from messages where referral is not null');
  if (count > 0) {
    throw new Error(
      `Cannot roll back 054_message_referral: ${count} real message(s) carry referral (ad-attribution) data. ` +
      `Export/back up first if it needs to be kept, then retry this rollback.`
    );
  }
  pgm.dropColumns('messages', ['referral']);
};
