// Limited-Time-Offer templates (build-docs/features/limited-time-offer-templates.md).
// A broadcast sending an LTO template with hasExpiration needs one fixed
// expiry moment set once at creation and reused for every recipient -
// mirrors header_media_asset_id's existing "set once, applied per
// recipient in broadcastRunner" pattern (migration 031).
exports.up = (pgm) => {
  pgm.addColumns('broadcasts', {
    limited_time_offer_expiration_ms: { type: 'bigint' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('broadcasts', ['limited_time_offer_expiration_ms']);
};
