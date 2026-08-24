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
const dns = require('dns').promises;
const net = require('net');
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

// Single source of truth for header-media constraints — originally lived in
// routes/templates.js only; exported from here now that resolveMediaIdFromUrl
// (below) needs the same limits to validate a CRM-supplied URL, and
// routes/templates.js imports this instead of keeping its own copy.
const MEDIA_HEADER_LIMITS = {
  IMAGE: { maxBytes: 5 * 1024 * 1024, mimeTypes: { 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png' } },
  VIDEO: { maxBytes: 16 * 1024 * 1024, mimeTypes: { 'video/mp4': 'video/mp4' } },
  DOCUMENT: { maxBytes: 100 * 1024 * 1024, mimeTypes: { 'application/pdf': 'application/pdf' } },
};

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
//
// assetId (optional): points at a specific non-default asset row (see
// templateMediaCacheRepo.insertAsset / migration 030) uploaded just for one
// send — a chat message, a broadcast, a flow node — instead of the
// template's approval-time default. Omitted, this resolves the default
// exactly as before.
async function resolveMediaId(db, clientId, waba, accessToken, template, assetId) {
  const cached = assetId
    ? await templateMediaCacheRepo.findAssetById(db, clientId, assetId)
    : await templateMediaCacheRepo.findByTemplateId(db, clientId, template.id);
  if (!cached) {
    throw new MediaResolutionError(
      assetId
        ? `The selected media for "${template.name}" could not be found (it may have been removed) — choose a file again before sending.`
        : `"${template.name}"'s header media was never uploaded through this app (or that record was lost) — re-upload the header media for this template before it can be sent.`
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
    const updated = assetId
      ? await templateMediaCacheRepo.updateAsset(db, clientId, assetId, { mediaId: uploaded.id, filename: cached.filename })
      : await templateMediaCacheRepo.upsert(db, clientId, template.id, { mediaId: uploaded.id, filename: cached.filename });
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

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inIpv4Range(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

// Blocks the address ranges an SSRF payload would actually target: loopback,
// RFC1918 private space, link-local (which is also where cloud providers
// serve instance-metadata credentials — 169.254.169.254), and a few less
// common but still non-public blocks. Not an exhaustive IANA reservation
// list — just enough to keep a CRM-supplied "fetch this URL" from reaching
// this server's own network.
const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return BLOCKED_IPV4_RANGES.some(([base, bits]) => inIpv4Range(ip, base, bits));
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true; // link-local + unique local
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped IPv6
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }
  return true; // couldn't classify it — fail closed
}

// Guards against sending this server fetching its own internal network (or
// a cloud metadata endpoint) on a CRM's behalf. Resolves the hostname itself
// rather than trusting fetch()'s own resolution, since the check has to run
// before any request goes out.
async function assertPublicHttpsUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new MediaResolutionError(`"${rawUrl}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new MediaResolutionError('headerMediaUrl must be an https:// URL.');
  }
  let addresses;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true });
  } catch {
    throw new MediaResolutionError(`Could not resolve host "${parsed.hostname}".`);
  }
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    throw new MediaResolutionError(`"${parsed.hostname}" resolves to a non-public address and can't be fetched.`);
  }
  return parsed;
}

// A CRM-supplied document/image/video URL for one send (Hub API's
// headerMediaUrl, see routes/apiV1Messages.js) — the alternative to
// resolveMediaId's asset-id lookup, for a caller that has never uploaded
// anything through this app's UI. Downloads the file itself (Meta's
// template `link` parameter is documented as less reliable than `id`, and
// every other send path here already goes through an uploaded media id —
// see the module comment), uploads it to Meta, and caches the resulting id
// as a new non-default asset so a retry of the same logical send can reuse
// it without a second fetch.
async function resolveMediaIdFromUrl(db, clientId, waba, accessToken, template, mediaUrl, filename) {
  const parsed = await assertPublicHttpsUrl(mediaUrl);
  const limits = MEDIA_HEADER_LIMITS[template.header_type];

  let res;
  try {
    res = await fetch(parsed, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new MediaResolutionError(`Could not fetch headerMediaUrl: ${err.message}`);
  }
  if (!res.ok) {
    throw new MediaResolutionError(`headerMediaUrl responded with ${res.status} ${res.statusText}.`);
  }
  const contentLength = Number(res.headers.get('content-length') || 0);
  if (contentLength && contentLength > limits.maxBytes) {
    throw new MediaResolutionError(
      `headerMediaUrl's file is too large for a ${template.header_type.toLowerCase()} header (limit ${Math.round(limits.maxBytes / (1024 * 1024))}MB).`
    );
  }
  const rawContentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  const mimeType = limits.mimeTypes[rawContentType];
  if (!mimeType) {
    throw new MediaResolutionError(
      `headerMediaUrl's Content-Type ("${rawContentType || 'unknown'}") isn't accepted for a ${template.header_type} header — expected: ${Object.keys(limits.mimeTypes).join(', ')}.`
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > limits.maxBytes) {
    throw new MediaResolutionError(
      `headerMediaUrl's file is too large for a ${template.header_type.toLowerCase()} header (limit ${Math.round(limits.maxBytes / (1024 * 1024))}MB).`
    );
  }

  const resolvedFilename = template.header_type === 'DOCUMENT'
    ? (filename || decodeURIComponent(parsed.pathname.split('/').pop() || '') || null)
    : null;

  let uploaded;
  try {
    uploaded = await metaClient.uploadMedia(waba.phone_number_id, accessToken, buffer, mimeType, resolvedFilename || undefined);
  } catch (err) {
    throw new MediaResolutionError(`Could not upload headerMediaUrl's file to Meta: ${err.message}`);
  }

  const asset = await templateMediaCacheRepo.insertAsset(db, clientId, template.id, { mediaId: uploaded.id, filename: resolvedFilename });
  return { mediaId: asset.media_id, filename: asset.filename };
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
  resolveMediaIdFromUrl,
  buildMediaHeaderComponent,
  MediaResolutionError,
  REFRESH_THRESHOLD_MS,
  MEDIA_HEADER_LIMITS,
  // Exported for the SSRF-guard unit tests (test/mediaHeaderService.test.js)
  // — pure and DNS-free for IP-literal input, so testable without a network.
  isBlockedAddress,
  assertPublicHttpsUrl,
};
