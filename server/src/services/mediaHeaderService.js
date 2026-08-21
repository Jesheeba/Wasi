// Resolves the `media id` a media-header template (IMAGE/VIDEO/DOCUMENT)
// needs at SEND time — a different Meta object than the `header_handle`
// used at template CREATION time (Resumable Upload API, see
// routes/templates.js). Shared by every send path (broadcastRunner,
// flowEngine, the one-off chat send) via messagingService.sendChatMessage,
// the single place that already holds a decrypted access token.
//
// Design (see migration 028_template_media_cache.js and the media-header
// investigation this was scoped from): a media id is reusable across many
// messages but expires 30 days after upload. Rather than persisting the
// original file ourselves (explicitly out of scope — no media library),
// Meta is the file store: before a cached id's 30-day window closes, this
// downloads the media back via GET /{media-id} and re-uploads it to mint a
// fresh id. One resolve serves an entire broadcast run AND every flow
// execution that hits the same template, not one upload per recipient/
// contact — that reuse is the whole point of caching by template_id rather
// than resolving fresh on every send.
const metaClient = require('../utils/metaClient');
const templateMediaCacheRepo = require('../repositories/templateMediaCacheRepo');

// Refresh before the real 30-day expiry, not at the edge of it — a
// broadcast or flow send that straddles the threshold should never race a
// download against Meta actually deleting the media.
const REFRESH_THRESHOLD_MS = 25 * 24 * 60 * 60 * 1000;

const MEDIA_HEADER_TYPES = new Set(['IMAGE', 'VIDEO', 'DOCUMENT']);
function isMediaHeaderType(headerType) {
  return MEDIA_HEADER_TYPES.has(headerType);
}

// Distinct from a Meta rejection (MessagingError 'send_failed') — this
// means the send never reached Meta at all because there was no valid media
// id to send with. messagingService wraps this as MessagingError
// 'media_resolution_failed' so every existing caller (chats route,
// broadcastRunner, flowEngine) surfaces err.message without needing to know
// this error type exists.
class MediaResolutionError extends Error {}

// The initial cache seed happens directly in routes/templates.js, not here
// — template creation needs the standard Media API upload interleaved with
// the Resumable Upload API call (for the creation-time handle) and the
// local template row (the cache write needs its id), in a specific order;
// there's no clean single call this module could offer that fits that
// sequence, so it isn't duplicated here as a thin wrapper.
async function resolveMediaId(db, clientId, waba, accessToken, template) {
  const cached = await templateMediaCacheRepo.findByTemplateId(db, clientId, template.id);
  if (!cached) {
    throw new MediaResolutionError(
      `"${template.name}"'s header media was never uploaded through this app (or that record was lost) — re-upload the header media for this template before it can be sent.`
    );
  }

  const ageMs = Date.now() - new Date(cached.resolved_at).getTime();
  if (ageMs < REFRESH_THRESHOLD_MS) {
    return { mediaId: cached.media_id, filename: cached.filename };
  }

  try {
    const { url } = await metaClient.getMediaUrl(cached.media_id, accessToken);
    const { buffer, mimeType } = await metaClient.downloadMediaBytes(url, accessToken);
    const uploaded = await metaClient.uploadMedia(
      waba.phone_number_id, accessToken, buffer, mimeType, cached.filename || undefined
    );
    const updated = await templateMediaCacheRepo.upsert(db, clientId, template.id, {
      mediaId: uploaded.id, filename: cached.filename,
    });
    return { mediaId: updated.media_id, filename: updated.filename };
  } catch (err) {
    // Refresh failing means the cached id itself is at or past 30 days and
    // Meta no longer has it to hand back — no local copy to fall back to,
    // by design (see module comment). Rare: only reachable if a send
    // legitimately sat unresolved for the entire refresh margin, or the
    // cache row's resolved_at is stale relative to reality.
    throw new MediaResolutionError(
      `"${template.name}"'s header media could not be refreshed — its copy on Meta's side has likely expired. Re-upload the header media for this template before it can be sent. (${err.message})`
    );
  }
}

// Meta's send-time header parameter shape — lowercase type key, matching a
// plain media message's shape (see metaClient.sendTemplateMessage's
// `components`). `filename` is Meta-recommended (not required) for a
// document header so it displays as something other than an opaque name.
function buildMediaHeaderComponent(headerType, mediaId, filename) {
  const key = headerType.toLowerCase();
  const mediaObject = { id: mediaId };
  if (key === 'document' && filename) mediaObject.filename = filename;
  return { type: 'header', parameters: [{ type: key, [key]: mediaObject }] };
}

module.exports = {
  isMediaHeaderType,
  resolveMediaId,
  buildMediaHeaderComponent,
  MediaResolutionError,
  REFRESH_THRESHOLD_MS,
};
