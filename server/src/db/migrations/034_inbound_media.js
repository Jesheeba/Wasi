// GAP_FIX_PLAN.md Phase E1 — inbound media (images/audio/video/documents/
// stickers a customer sends in) was previously rendered only as a
// "[type]" placeholder with no way to actually see it. Deliberately NOT
// storing the file bytes ourselves — this app's existing design for
// outbound header media (services/mediaHeaderService.js's module comment)
// treats Meta as the file store rather than building a media library, and
// this keeps that same posture for inbound: only Meta's own media id is
// persisted here, fetched on demand through a proxy route
// (routes/chats.js) when someone actually views it. No new storage
// bucket, no retention/deletion policy to build, no new surface to wire
// into the GDPR data-deletion webhook.
exports.up = (pgm) => {
  pgm.addColumns('messages', {
    media_id: { type: 'text' },
    media_mime_type: { type: 'text' },
    // Meta only sends a filename for document messages — null for every
    // other media type, matching mediaHeaderService's own asset filename
    // handling (also null except for DOCUMENT headers).
    media_filename: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('messages', ['media_id', 'media_mime_type', 'media_filename']);
};
