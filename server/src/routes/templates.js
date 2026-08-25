const { Router } = require('express');
const multer = require('multer');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const templateMediaCacheRepo = require('../repositories/templateMediaCacheRepo');
const wabasRepo = require('../repositories/wabasRepo');
const metaClient = require('../utils/metaClient');
const mediaHeaderService = require('../services/mediaHeaderService');
const { decrypt } = require('../utils/encryption');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, messageTemplateCreateSchema } = require('../utils/validate');
const { validateTemplateText, validateHeaderText } = require('../utils/templateParams');
const templateSyncService = require('../services/templateSyncService');

const router = Router();

// Meta's own documented limits per header media type — now lives in
// mediaHeaderService.js (resolveMediaIdFromUrl needs the same limits to
// validate a CRM-supplied URL), imported here rather than duplicated.
const { MEDIA_HEADER_LIMITS } = mediaHeaderService;
// Multer's own limit is set to the largest of the three (DOCUMENT) — the
// per-type check above is what actually enforces the tighter IMAGE/VIDEO
// caps with a specific error message; this is just a hard backstop.
const uploadHeaderMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEDIA_HEADER_LIMITS.DOCUMENT.maxBytes },
});

router.get('/', asyncHandler(async (req, res) => {
  res.json(await messageTemplatesRepo.listByClientId(req.db, req.clientId));
}));

// Manual "Sync" button on the templates page — reconciles against Meta's
// real template list on demand, not just automatically once after
// Embedded Signup (onboarding.js). Returns counts rather than the app
// silently re-fetching, so the UI can show what actually changed.
router.post('/sync', asyncHandler(async (req, res) => {
  try {
    const result = await templateSyncService.syncTemplates(req.db, req.clientId);
    res.json(result);
  } catch (err) {
    if (err instanceof templateSyncService.TemplateSyncError) {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    return res.status(502).json({ error: 'Template sync failed', detail: err.message });
  }
}));

// Submits to Meta for real approval when a WABA is connected — approval
// status then arrives asynchronously via the message_template_status_update
// webhook (server/src/routes/metaWebhook.js), same as it does for templates
// created directly in Meta Business Manager. Without a connected WABA yet,
// still saves locally as 'pending' so template drafting isn't blocked on
// onboarding order (spec allows connecting WhatsApp after initial signup)
// — EXCEPT for a media header (IMAGE/VIDEO/DOCUMENT), which requires a
// connected WABA up front: the header's file has to be uploaded to Meta
// immediately (both for the template's creation-time example handle and
// for this app's own send-time media-id cache — see mediaHeaderService.js),
// and there's nowhere to hold the file for later since this isn't a media
// library (see migration 028_template_media_cache.js's comment). A media
// template just can't be meaningfully drafted before WhatsApp is connected.
//
// multer.single('headerFile') is a no-op for a plain JSON request (no
// multipart body) — req.file stays undefined and req.body is whatever
// express.json() already parsed, so the TEXT/NONE-header path below is
// completely unchanged. A media-header request instead sends the JSON
// payload as a 'data' form field (JSON.stringify'd, since a template's
// buttons/bodyParamExamples don't fit as flat multipart fields) alongside
// the file — see app.js's createTemplate submit handler.
router.post('/', uploadHeaderMedia.single('headerFile'), asyncHandler(async (req, res) => {
  let rawBody = req.body;
  if (req.file) {
    try {
      rawBody = JSON.parse(req.body.data || '{}');
    } catch (err) {
      return res.status(400).json({ error: 'Malformed request', detail: 'The "data" field must be valid JSON.' });
    }
  }
  const data = messageTemplateCreateSchema.parse(rawBody);
  const isMediaHeader = mediaHeaderService.isMediaHeaderType(data.header?.type);

  // Validated up front, regardless of WABA connection state, so a bad body
  // or header never gets silently saved as 'pending' without telling the
  // author why. Category-aware: Authentication has no author-supplied
  // body/header (messageTemplateCreateSchema's superRefine already rejects
  // one being present), so there's nothing here to check for it.
  if (data.category !== 'Authentication') {
    const bodyValidation = validateTemplateText(data.body, { label: 'Body' });
    if (!bodyValidation.valid) {
      return res.status(400).json({ error: 'Invalid template body', details: bodyValidation.errors });
    }

    // Sample-value coverage is checked here, not in the schema — by this
    // point bodyValidation.params is confirmed to be well-formed named
    // parameters (not numbered, not mixed), so "missing" can only mean an
    // actually-missing sample, not a numbered-param body producing a
    // confusing "sample required for: 1". See validate.js's comment on why
    // this moved out of messageTemplateCreateSchema's superRefine.
    const examples = data.bodyParamExamples || {};
    const missingSamples = bodyValidation.params.filter((p) => !String(examples[p] || '').trim());
    if (missingSamples.length > 0) {
      return res.status(400).json({
        error: 'Missing sample values',
        details: [`Sample value required for: ${missingSamples.join(', ')} — Meta rejects templates without one.`],
      });
    }

    if (data.header?.type === 'TEXT') {
      const headerValidation = validateHeaderText(data.header.text || '');
      if (!headerValidation.valid) {
        return res.status(400).json({ error: 'Invalid template header', details: headerValidation.errors });
      }
    }

    if (isMediaHeader) {
      const limits = MEDIA_HEADER_LIMITS[data.header.type];
      if (!req.file) {
        return res.status(400).json({ error: 'Missing header media', detail: `An ${data.header.type.toLowerCase()} file is required for this header type.` });
      }
      const mimeType = limits.mimeTypes[req.file.mimetype];
      if (!mimeType) {
        return res.status(400).json({
          error: 'Unsupported file type',
          detail: `${data.header.type} headers accept: ${Object.keys(limits.mimeTypes).join(', ')}.`,
        });
      }
      if (req.file.size > limits.maxBytes) {
        return res.status(400).json({
          error: 'File too large',
          detail: `${data.header.type} headers are limited to ${Math.round(limits.maxBytes / (1024 * 1024))}MB.`,
        });
      }
    }
  }

  const waba = await wabasRepo.findByClientId(req.clientId);

  if (isMediaHeader && (!waba || waba.status !== 'connected' || !waba.access_token_encrypted)) {
    return res.status(400).json({
      error: 'Connect WhatsApp first',
      detail: 'An image, video, or document header needs to be uploaded to your connected WhatsApp number — connect WhatsApp before creating this template.',
    });
  }

  let metaTemplateId = null;
  let seededMedia = null; // { mediaId, filename } — set once the standard Media API upload succeeds

  if (waba && waba.status === 'connected' && waba.access_token_encrypted) {
    // Checked first, before touching the access token at all — a pure
    // local-DB read, no Meta call needed (see messageTemplatesRepo.
    // findActiveByNameAndLanguage's comment). Meta scopes template
    // uniqueness to (name, language) per WABA, not name alone; a second
    // submission under a combination Meta already has something for
    // doesn't get cleanly rejected there — it queues for review and can
    // sit unresolved far longer than normal (confirmed live: 20+ hours
    // pending against an already-approved same-name-and-language
    // template). Caught here instead of discovered a day later.
    const collisions = await messageTemplatesRepo.findActiveByNameAndLanguage(req.db, req.clientId, data.name, data.language);
    if (collisions.length > 0) {
      const existing = collisions[0];
      return res.status(409).json({
        error: `A template named "${data.name}" in ${data.language} already exists on this WhatsApp number (currently ${existing.status}) — WhatsApp treats name+language as one slot, so a second submission under the same combination won't be cleanly rejected, it'll sit in review indefinitely instead. Use a different name, or remove the existing one first.`,
      });
    }

    // Decryption failure is a distinct error class from Meta rejecting the
    // template — it means the request never reached Meta at all (wrong
    // SERVER_SECRET for this row's ciphertext, or a corrupted value).
    // Lumping it into "Meta rejected this template" is actively
    // misleading — it sends someone hunting for a content problem that
    // doesn't exist, when the real fix is a key/env mismatch.
    let accessToken;
    try {
      accessToken = await decrypt(waba.access_token_encrypted);
    } catch (err) {
      return res.status(500).json({
        error: 'Could not decrypt this WABA\'s access token — the request never reached Meta',
        detail: 'SERVER_SECRET in this environment does not match the key that encrypted the stored token (a secret rotation, or a mismatch between local and production config).',
      });
    }

    if (isMediaHeader) {
      if (!process.env.META_APP_ID) {
        return res.status(502).json({ error: 'META_APP_ID is not configured for this environment' });
      }
      const mimeType = MEDIA_HEADER_LIMITS[data.header.type].mimeTypes[req.file.mimetype];
      try {
        // Two separate Meta uploads from the same bytes, both required, both
        // done now — never deferred (handle lifetime is undocumented, see
        // the media-header investigation). 1) the Resumable Upload API
        // handle Meta requires as the template's creation-time example.
        // 2) the standard Media API id this app will actually send with —
        // resolved and cached now so day-one sending works without a second
        // round of uploads.
        const session = await metaClient.createUploadSession(process.env.META_APP_ID, accessToken, {
          fileName: req.file.originalname || data.header.type.toLowerCase(),
          fileLength: req.file.size,
          fileType: mimeType,
        });
        const uploadedHandle = await metaClient.uploadFileBytes(session.id, accessToken, req.file.buffer);
        if (!uploadedHandle.h) throw new Error('Meta did not return an upload handle');
        data.header.handle = uploadedHandle.h;

        const uploadedMedia = await metaClient.uploadMedia(waba.phone_number_id, accessToken, req.file.buffer, mimeType, req.file.originalname);
        seededMedia = { mediaId: uploadedMedia.id, filename: data.header.type === 'DOCUMENT' ? (req.file.originalname || null) : null };
      } catch (err) {
        return res.status(502).json({ error: 'Could not upload header media to Meta', detail: err.message });
      }
    }

    try {
      // { id, status, category } — capture the id now (templateSyncService.js's
      // reconcile matches by it going forward) rather than leaving it to the
      // next sync to backfill by name.
      const metaResponse = await metaClient.createMessageTemplate(waba.waba_id, accessToken, data);
      metaTemplateId = metaResponse.id;
    } catch (err) {
      if (err instanceof metaClient.TemplateValidationError) {
        return res.status(400).json({ error: 'Invalid template', details: err.errors });
      }
      return res.status(502).json({ error: 'Meta rejected this template', detail: err.message });
    }
  }

  const template = await messageTemplatesRepo.create(req.db, {
    client_id: req.clientId,
    ...data,
    status: 'pending',
    meta_template_id: metaTemplateId,
  });

  if (seededMedia) {
    await templateMediaCacheRepo.upsert(req.db, req.clientId, template.id, seededMedia);
  }

  res.status(201).json(template);
}));

// Uploads a new media asset for a media-header template, for one send to
// point at instead of the template's approval-time default sample (see
// templateMediaCacheRepo.insertAsset / migration 030_template_media_assets.js).
// Reused by the chat send-template modal, the broadcast-creation modal, and
// the flow editor's Send Template node — all three just need { id, filename }
// back to attach to their own send/create call as headerMediaAssetId.
router.post('/:id/header-media', uploadHeaderMedia.single('file'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const template = await messageTemplatesRepo.findById(req.db, req.clientId, req.params.id);
  if (!template) return res.status(404).json({ error: 'Not found' });
  if (!mediaHeaderService.isMediaHeaderType(template.header_type)) {
    return res.status(400).json({
      error: `"${template.name}" does not have a media header — only IMAGE/VIDEO/DOCUMENT header templates accept uploaded media.`,
    });
  }

  const limits = MEDIA_HEADER_LIMITS[template.header_type];
  if (!req.file) {
    return res.status(400).json({ error: 'Missing file', detail: `A ${template.header_type.toLowerCase()} file is required.` });
  }
  const mimeType = limits.mimeTypes[req.file.mimetype];
  if (!mimeType) {
    return res.status(400).json({
      error: 'Unsupported file type',
      detail: `${template.header_type} headers accept: ${Object.keys(limits.mimeTypes).join(', ')}.`,
    });
  }
  if (req.file.size > limits.maxBytes) {
    return res.status(400).json({
      error: 'File too large',
      detail: `${template.header_type} headers are limited to ${Math.round(limits.maxBytes / (1024 * 1024))}MB.`,
    });
  }

  const waba = await wabasRepo.findByClientId(req.clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) {
    return res.status(400).json({
      error: 'Connect WhatsApp first',
      detail: 'Uploading header media needs a connected WhatsApp number.',
    });
  }

  let accessToken;
  try {
    accessToken = await decrypt(waba.access_token_encrypted);
  } catch (err) {
    return res.status(500).json({
      error: 'Could not decrypt this WABA\'s access token',
      detail: 'SERVER_SECRET in this environment does not match the key that encrypted the stored token.',
    });
  }

  let uploaded;
  try {
    uploaded = await metaClient.uploadMedia(waba.phone_number_id, accessToken, req.file.buffer, mimeType, req.file.originalname);
  } catch (err) {
    return res.status(502).json({ error: 'Could not upload media to Meta', detail: err.message });
  }

  // Recommended (not required) by Meta for a document header send, same as
  // the approval-time seed in the POST / handler above — null for IMAGE/VIDEO.
  const filename = template.header_type === 'DOCUMENT' ? (req.file.originalname || null) : null;
  const asset = await templateMediaCacheRepo.insertAsset(req.db, req.clientId, template.id, { mediaId: uploaded.id, filename });
  res.status(201).json({ id: asset.id, filename: asset.filename });
}));

module.exports = router;
