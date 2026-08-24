// Lets a broadcast point at a specific uploaded media asset (see migration
// 030_template_media_assets.js) instead of always falling back to the
// template's approval-time default sample — set at campaign-creation time in
// routes/broadcasts.js, read by broadcastRunner.js for every recipient send.
exports.up = (pgm) => {
  pgm.addColumns('broadcasts', {
    header_media_asset_id: { type: 'uuid', references: 'template_media_cache', onDelete: 'SET NULL' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('broadcasts', ['header_media_asset_id']);
};
