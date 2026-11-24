const { Router } = require('express');
const multer = require('multer');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const templateMediaCacheRepo = require('../repositories/templateMediaCacheRepo');
const wabasRepo = require('../repositories/wabasRepo');
const metaClient = require('../utils/metaClient');
const mediaHeaderService = require('../services/mediaHeaderService');
const { decrypt } = require('../utils/encryption');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, messageTemplateCreateSchema, messageTemplateUpdateSchema } = require('../utils/validate');
const { validateTemplateText, validateHeaderText, checkCategoryContentMismatch } = require('../utils/templateParams');
const templateSyncService = require('../services/templateSyncService');
const { requireRole } = require('../middleware/requireRole');

const router = Router();

// Meta's raw error object (metaClient.js's graphFetch attaches it to a
// thrown error as err.metaError) often carries a more specific,
// human-readable explanation in error_user_title/error_user_msg than the
// flat err.message alone - e.g. a words-ratio rejection's flat message can
// be as terse as "Invalid parameter", while error_user_msg spells out the
// actual reason ("Params Words Ratio Exceeds Limit..."). Every route below
// that surfaces a real Meta rejection uses this instead of err.message
// directly, so app.js's toast (extractApiErrorDetail) shows the most
// specific reason Meta actually gave, not a generic one - found live when
// a client submitting a real template only saw a content-free rejection
// popup because this route was passing along the terse message alone.
function describeMetaError(err) {
  const meta = err.metaError;
  if (meta && (meta.error_user_title || meta.error_user_msg)) {
    return [meta.error_user_title, meta.error_user_msg].filter(Boolean).join(' - ');
  }
  return err.message;
}

// Meta's own documented limits per header media type - now lives in
// mediaHeaderService.js (resolveMediaIdFromUrl needs the same limits to
// validate a CRM-supplied URL), imported here rather than duplicated.
const { MEDIA_HEADER_LIMITS } = mediaHeaderService;
// Multer's own limit is set to the largest of the three (DOCUMENT) - the
// per-type check above is what actually enforces the tighter IMAGE/VIDEO
// caps with a specific error message; this is just a hard backstop.
const uploadHeaderMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEDIA_HEADER_LIMITS.DOCUMENT.maxBytes },
});
// Carousel templates (build-docs/features/carousel-templates.md) need up
// to 10 card files alongside (never together with) the single headerFile
// a non-carousel media-header template uses - one multer config handles
// both shapes via .fields(), POST / only (the other upload routes in this
// file are single-asset, unrelated to template creation).
const uploadTemplateMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEDIA_HEADER_LIMITS.DOCUMENT.maxBytes },
}).fields([{ name: 'headerFile', maxCount: 1 }, { name: 'cardFiles', maxCount: 10 }]);

router.get('/', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  res.json(await messageTemplatesRepo.listByClientId(req.db, req.clientId));
}));

// Checked live, before submission - a button/LTO/carousel-card URL that's
// malformed or dead was previously only ever discovered after the full
// Meta round trip (create a template, wait for the real 502), which is
// slow to iterate on. This is a cheap pre-flight: format (reused from
// mediaHeaderService's SSRF guard - this route fetches a CRM-author-
// supplied URL on the author's own behalf, same risk class as
// resolveMediaIdFromUrl) + an actual live reachability check, reported
// as a non-blocking signal the UI shows next to the field - never a hard
// submit block, since a real site can legitimately reject a bot HEAD/GET
// (anti-scraping, auth walls) while still being a perfectly valid button
// destination for a human tapping it in WhatsApp.
router.get('/verify-url', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  const rawUrl = String(req.query.url || '');
  let parsed;
  try {
    parsed = await mediaHeaderService.assertPublicHttpsUrl(rawUrl);
  } catch (err) {
    return res.json({ reachable: false, error: err.message });
  }

  // HEAD first (cheapest - no body transferred), falling back to GET for
  // a server that rejects HEAD outright (common misconfiguration, not a
  // real signal the URL is bad) - this app only needs to know a response
  // arrived, never the body, so a GET here still doesn't read it.
  for (const method of ['HEAD', 'GET']) {
    try {
      const response = await fetch(parsed, { method, redirect: 'follow', signal: AbortSignal.timeout(6000) });
      if (response.ok) return res.json({ reachable: true, status: response.status });
      if (method === 'GET') return res.json({ reachable: false, status: response.status, error: `Responded with ${response.status} ${response.statusText}` });
    } catch (err) {
      if (method === 'GET') return res.json({ reachable: false, error: err.name === 'TimeoutError' ? 'Timed out after 6s' : err.message });
    }
  }
}));

// Shared between POST / (create) and PUT /:id (edit) - the same body/
// sample-value/header-text rules apply to a brand-new template and an
// edited one. Media-header file checks stay in POST only: PUT's own schema
// (messageTemplateUpdateSchema) restricts header.type to NONE/TEXT, so a
// media header never reaches this far via the edit path. Returns null when
// valid, or the {status, body} to send as the response otherwise.
function validateStandardTemplateFields(data) {
  const bodyValidation = validateTemplateText(data.body, { label: 'Body' });
  if (!bodyValidation.valid) {
    return { status: 400, body: { error: 'Invalid template body', details: bodyValidation.errors } };
  }

  // Sample-value coverage is checked here, not in either schema - by this
  // point bodyValidation.params is confirmed to be well-formed named
  // parameters (not numbered, not mixed), so "missing" can only mean an
  // actually-missing sample, not a numbered-param body producing a
  // confusing "sample required for: 1". See validate.js's comment on why
  // this moved out of messageTemplateCreateSchema's superRefine.
  const examples = data.bodyParamExamples || {};
  const missingSamples = bodyValidation.params.filter((p) => !String(examples[p] || '').trim());
  if (missingSamples.length > 0) {
    return {
      status: 400,
      body: { error: 'Missing sample values', details: [`Sample value required for: ${missingSamples.join(', ')} - Meta rejects templates without one.`] },
    };
  }

  if (data.header?.type === 'TEXT') {
    const headerValidation = validateHeaderText(data.header.text || '');
    if (!headerValidation.valid) {
      return { status: 400, body: { error: 'Invalid template header', details: headerValidation.errors } };
    }
  }

  return null;
}

// Manual "Sync" button on the templates page - reconciles against Meta's
// real template list on demand, not just automatically once after
// Embedded Signup (onboarding.js). Returns counts rather than the app
// silently re-fetching, so the UI can show what actually changed.
router.post('/sync', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
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

// Submits to Meta for real approval when a WABA is connected - approval
// status then arrives asynchronously via the message_template_status_update
// webhook (server/src/routes/metaWebhook.js), same as it does for templates
// created directly in Meta Business Manager. Without a connected WABA yet,
// still saves locally as 'pending' so template drafting isn't blocked on
// onboarding order (spec allows connecting WhatsApp after initial signup)
// - EXCEPT for a media header (IMAGE/VIDEO/DOCUMENT), which requires a
// connected WABA up front: the header's file has to be uploaded to Meta
// immediately (both for the template's creation-time example handle and
// for this app's own send-time media-id cache - see mediaHeaderService.js),
// and there's nowhere to hold the file for later since this isn't a media
// library (see migration 028_template_media_cache.js's comment). A media
// template just can't be meaningfully drafted before WhatsApp is connected.
//
// multer.single('headerFile') is a no-op for a plain JSON request (no
// multipart body) - req.file stays undefined and req.body is whatever
// express.json() already parsed, so the TEXT/NONE-header path below is
// completely unchanged. A media-header request instead sends the JSON
// payload as a 'data' form field (JSON.stringify'd, since a template's
// buttons/bodyParamExamples don't fit as flat multipart fields) alongside
// the file - see app.js's createTemplate submit handler.
router.post('/', requireRole('Admin', 'Manager'), uploadTemplateMedia, asyncHandler(async (req, res) => {
  const headerFile = req.files?.headerFile?.[0];
  const cardFiles = req.files?.cardFiles || [];
  let rawBody = req.body;
  if (headerFile || cardFiles.length > 0) {
    try {
      rawBody = JSON.parse(req.body.data || '{}');
    } catch (err) {
      return res.status(400).json({ error: 'Malformed request', detail: 'The "data" field must be valid JSON.' });
    }
  }
  const data = messageTemplateCreateSchema.parse(rawBody);
  const isMediaHeader = mediaHeaderService.isMediaHeaderType(data.header?.type);
  const isCarousel = Array.isArray(data.cards);

  // Validated up front, regardless of WABA connection state, so a bad body
  // or header never gets silently saved as 'pending' without telling the
  // author why. Category-aware: Authentication has no author-supplied
  // body/header (messageTemplateCreateSchema's superRefine already rejects
  // one being present), so there's nothing here to check for it.
  if (data.category !== 'Authentication') {
    const validationError = validateStandardTemplateFields(data);
    if (validationError) return res.status(validationError.status).json(validationError.body);

    if (isMediaHeader) {
      const limits = MEDIA_HEADER_LIMITS[data.header.type];
      if (!headerFile) {
        return res.status(400).json({ error: 'Missing header media', detail: `An ${data.header.type.toLowerCase()} file is required for this header type.` });
      }
      const mimeType = limits.mimeTypes[headerFile.mimetype];
      if (!mimeType) {
        return res.status(400).json({
          error: 'Unsupported file type',
          detail: `${data.header.type} headers accept: ${Object.keys(limits.mimeTypes).join(', ')}.`,
        });
      }
      if (headerFile.size > limits.maxBytes) {
        return res.status(400).json({
          error: 'File too large',
          detail: `${data.header.type} headers are limited to ${Math.round(limits.maxBytes / (1024 * 1024))}MB.`,
        });
      }
    }

    if (isCarousel) {
      if (cardFiles.length !== data.cards.length) {
        return res.status(400).json({
          error: 'Missing card media',
          detail: `This carousel has ${data.cards.length} card(s) but ${cardFiles.length} file(s) were uploaded - exactly one file per card, in the same order, is required.`,
        });
      }
      for (let i = 0; i < data.cards.length; i++) {
        const limits = MEDIA_HEADER_LIMITS[data.cards[i].headerType];
        const mimeType = limits.mimeTypes[cardFiles[i].mimetype];
        if (!mimeType) {
          return res.status(400).json({
            error: 'Unsupported file type',
            detail: `Card ${i + 1}: ${data.cards[i].headerType} headers accept: ${Object.keys(limits.mimeTypes).join(', ')}.`,
          });
        }
        if (cardFiles[i].size > limits.maxBytes) {
          return res.status(400).json({
            error: 'File too large',
            detail: `Card ${i + 1}: ${data.cards[i].headerType} headers are limited to ${Math.round(limits.maxBytes / (1024 * 1024))}MB.`,
          });
        }
      }
    }
  }

  const waba = await wabasRepo.findByClientId(req.clientId);

  if ((isMediaHeader || isCarousel) && (!waba || waba.status !== 'connected' || !waba.access_token_encrypted)) {
    return res.status(400).json({
      error: 'Connect WhatsApp first',
      detail: isCarousel
        ? 'A carousel template\'s card images/videos need to be uploaded to your connected WhatsApp number - connect WhatsApp before creating this template.'
        : 'An image, video, or document header needs to be uploaded to your connected WhatsApp number - connect WhatsApp before creating this template.',
    });
  }

  let metaTemplateId = null;
  let metaStatus = null; // Meta's review status in its create response (often APPROVED at once)
  let metaCategory = null; // Meta's category in its create response - may differ from the submitted one
  let seededMedia = null; // { mediaId, filename } - set once the standard Media API upload succeeds
  let seededCardMedia = null; // [{ mediaId, filename }, ...] - one per card, same order as data.cards

  if (waba && waba.status === 'connected' && waba.access_token_encrypted) {
    // Checked first, before touching the access token at all - a pure
    // local-DB read, no Meta call needed (see messageTemplatesRepo.
    // findActiveByNameAndLanguage's comment). Meta scopes template
    // uniqueness to (name, language) per WABA, not name alone; a second
    // submission under a combination Meta already has something for
    // doesn't get cleanly rejected there - it queues for review and can
    // sit unresolved far longer than normal (confirmed live: 20+ hours
    // pending against an already-approved same-name-and-language
    // template). Caught here instead of discovered a day later.
    const collisions = await messageTemplatesRepo.findActiveByNameAndLanguage(req.db, req.clientId, data.name, data.language);
    if (collisions.length > 0) {
      const existing = collisions[0];
      return res.status(409).json({
        error: `A template named "${data.name}" in ${data.language} already exists on this WhatsApp number (currently ${existing.status}) - WhatsApp treats name+language as one slot, so a second submission under the same combination won't be cleanly rejected, it'll sit in review indefinitely instead. Use a different name, or remove the existing one first.`,
      });
    }

    // Decryption failure is a distinct error class from Meta rejecting the
    // template - it means the request never reached Meta at all (wrong
    // SERVER_SECRET for this row's ciphertext, or a corrupted value).
    // Lumping it into "Meta rejected this template" is actively
    // misleading - it sends someone hunting for a content problem that
    // doesn't exist, when the real fix is a key/env mismatch.
    let accessToken;
    try {
      accessToken = decrypt(waba.access_token_encrypted);
    } catch (err) {
      return res.status(500).json({
        error: 'Could not decrypt this WABA\'s access token - the request never reached Meta',
        detail: 'SERVER_SECRET in this environment does not match the key that encrypted the stored token (a secret rotation, or a mismatch between local and production config).',
      });
    }

    // Releases the tenant DB connection before the first Meta call and
    // reacquires one only once every Meta round trip below is done - up to
    // 4 sequential Graph API calls for a media header (createUploadSession/
    // uploadFileBytes/uploadMedia/createMessageTemplate), each of which can
    // take seconds. Without this, this one request pins one of the pool's
    // few connections idle-in-transaction for that whole time - the same
    // reasoning routes/chats.js's send already documented and fixed
    // (messagingService.sendChatMessage's connectionHooks), never applied
    // here even though this route makes more Meta calls per request than
    // any other tenant route. A failure path below returns straight from
    // here with no further req.db use, so it needs no reacquire - only the
    // success path (past both try blocks) does, right before the local
    // writes.
    await req.commitAndRelease();

    if (isMediaHeader) {
      if (!process.env.META_APP_ID) {
        return res.status(502).json({ error: 'META_APP_ID is not configured for this environment' });
      }
      const mimeType = MEDIA_HEADER_LIMITS[data.header.type].mimeTypes[headerFile.mimetype];
      try {
        const uploaded = await mediaHeaderService.uploadTemplateHeaderMedia(waba, accessToken, data.header.type, headerFile, mimeType);
        data.header.handle = uploaded.handle;
        seededMedia = uploaded.seededMedia;
      } catch (err) {
        return res.status(502).json({ error: 'Could not upload header media to Meta', detail: describeMetaError(err), metaError: err.metaError || undefined });
      }
    }

    // Carousel (build-docs/features/carousel-templates.md) - same
    // two-upload-per-file dance as the single header above, just looped
    // per card. Stops (and returns) at the first failure, before
    // createMessageTemplate is ever called - no local row gets created
    // for a template Meta never received a complete card set for (no
    // partial-cards state is ever persisted).
    if (isCarousel) {
      if (!process.env.META_APP_ID) {
        return res.status(502).json({ error: 'META_APP_ID is not configured for this environment' });
      }
      seededCardMedia = [];
      for (let i = 0; i < data.cards.length; i++) {
        const card = data.cards[i];
        const file = cardFiles[i];
        const mimeType = MEDIA_HEADER_LIMITS[card.headerType].mimeTypes[file.mimetype];
        try {
          const session = await metaClient.createUploadSession(process.env.META_APP_ID, accessToken, {
            fileName: file.originalname || card.headerType.toLowerCase(),
            fileLength: file.size,
            fileType: mimeType,
          });
          const uploadedHandle = await metaClient.uploadFileBytes(session.id, accessToken, file.buffer);
          if (!uploadedHandle.h) throw new Error('Meta did not return an upload handle');
          card.headerHandle = uploadedHandle.h;

          const uploadedMedia = await metaClient.uploadMedia(waba.phone_number_id, accessToken, file.buffer, mimeType, file.originalname);
          seededCardMedia.push({ mediaId: uploadedMedia.id, filename: null });
        } catch (err) {
          return res.status(502).json({ error: `Could not upload card ${i + 1}'s media to Meta`, detail: describeMetaError(err), metaError: err.metaError || undefined });
        }
      }
    }

    try {
      // { id, status, category } - capture the id now (templateSyncService.js's
      // reconcile matches by it going forward) rather than leaving it to the
      // next sync to backfill by name.
      const metaResponse = await metaClient.createMessageTemplate(waba.waba_id, accessToken, data);
      metaTemplateId = metaResponse.id;
      metaCategory = metaResponse.category ? templateSyncService.mapMetaCategory(metaResponse.category) : null;
      // Meta often approves a Utility template instantly; keep its answer
      // instead of always storing pending until the next webhook or sync.
      metaStatus = metaResponse.status ? templateSyncService.mapMetaStatus(metaResponse.status) : null;
    } catch (err) {
      if (err instanceof metaClient.TemplateValidationError) {
        return res.status(400).json({ error: 'Invalid template', details: err.errors });
      }
      return res.status(502).json({ error: 'Meta rejected this template', detail: describeMetaError(err), metaError: err.metaError || undefined });
    }
  }

  // Only reached once every Meta call above has already returned - a fresh
  // connection is acquired here rather than reusing one held open through
  // those calls (see the commitAndRelease comment above). No-op (keeps the
  // original still-open connection) when the waba-connected branch above
  // was never entered at all - a draft with no WABA connected made no Meta
  // calls and never released anything.
  if (waba && waba.status === 'connected' && waba.access_token_encrypted) {
    req.db = await req.reacquireDb();
  }

  let template = await messageTemplatesRepo.create(req.db, {
    client_id: req.clientId,
    ...data,
    status: metaStatus || 'pending',
    meta_template_id: metaTemplateId,
  });
  if (metaCategory && metaCategory !== template.category) {
    template = (await messageTemplatesRepo.applyMetaCategory(req.db, template.id, metaCategory)) || template;
  }

  if (seededMedia) {
    await templateMediaCacheRepo.upsert(req.db, req.clientId, template.id, seededMedia);
  }
  if (seededCardMedia) {
    for (let i = 0; i < seededCardMedia.length; i++) {
      await templateMediaCacheRepo.upsert(req.db, req.clientId, template.id, { ...seededCardMedia[i], cardIndex: i });
    }
  }

  // Non-blocking - the CRM's own Create/Edit modal already shows this live
  // as the client types (see app.js's updateTemplateBodyValidation); this
  // covers every OTHER caller (Hub API, a script, anything that bypasses
  // that UI) with the same signal, on the same real-rejection evidence
  // (templateParams.js's own comment). Never withholds the 201 - the
  // template was already genuinely submitted to Meta by this point.
  const categoryCheck = checkCategoryContentMismatch(data.body, data.category);
  const warnings = [templateSyncService.categoryChangeWarning(template), categoryCheck.mismatch ? categoryCheck.warning : null].filter(Boolean);
  res.status(201).json(warnings.length ? { ...template, warnings } : template);
}));

// Uploads a new media asset for a media-header template, for one send to
// point at instead of the template's approval-time default sample (see
// templateMediaCacheRepo.insertAsset / migration 030_template_media_assets.js).
// Reused by the chat send-template modal, the broadcast-creation modal, and
// the flow editor's Send Template node - all three just need { id, filename }
// back to attach to their own send/create call as headerMediaAssetId.
// cardIndex (optional form field, build-docs/features/carousel-templates.md's
// "swap a carousel card's image without re-approval" gap) - Meta's own
// send-time shape for BOTH a single media header and a carousel card is
// just a media id reference, never baked into the approval; this app's
// gap was never asking for a new image, not a real Meta limitation. When
// given, this uploads against that specific card instead of the
// template's own (non-carousel) header - the one other branch this route
// needs, since a carousel template has no header_type of its own at all.
router.post('/:id/header-media', requireRole('Admin', 'Manager'), uploadHeaderMedia.single('file'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const template = await messageTemplatesRepo.findById(req.db, req.clientId, req.params.id);
  if (!template) return res.status(404).json({ error: 'Not found' });

  const cardIndex = req.body.cardIndex !== undefined && req.body.cardIndex !== '' ? Number(req.body.cardIndex) : null;
  let headerTypeForLimits;
  if (cardIndex !== null) {
    if (!Array.isArray(template.cards) || !Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= template.cards.length) {
      return res.status(400).json({ error: `"${template.name}" has no card at index ${req.body.cardIndex}.` });
    }
    headerTypeForLimits = template.cards[cardIndex].headerType;
  } else {
    if (!mediaHeaderService.isMediaHeaderType(template.header_type)) {
      return res.status(400).json({
        error: `"${template.name}" does not have a media header - only IMAGE/VIDEO/DOCUMENT header templates accept uploaded media.`,
      });
    }
    headerTypeForLimits = template.header_type;
  }

  const limits = MEDIA_HEADER_LIMITS[headerTypeForLimits];
  if (!req.file) {
    return res.status(400).json({ error: 'Missing file', detail: `A ${headerTypeForLimits.toLowerCase()} file is required.` });
  }
  const mimeType = limits.mimeTypes[req.file.mimetype];
  if (!mimeType) {
    return res.status(400).json({
      error: 'Unsupported file type',
      detail: `${headerTypeForLimits} headers accept: ${Object.keys(limits.mimeTypes).join(', ')}.`,
    });
  }
  if (req.file.size > limits.maxBytes) {
    return res.status(400).json({
      error: 'File too large',
      detail: `${headerTypeForLimits} headers are limited to ${Math.round(limits.maxBytes / (1024 * 1024))}MB.`,
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
    accessToken = decrypt(waba.access_token_encrypted);
  } catch (err) {
    return res.status(500).json({
      error: 'Could not decrypt this WABA\'s access token',
      detail: 'SERVER_SECRET in this environment does not match the key that encrypted the stored token.',
    });
  }

  // Same reasoning as POST /'s commitAndRelease - don't pin a tenant
  // connection idle-in-transaction for this Meta upload call.
  await req.commitAndRelease();

  let uploaded;
  try {
    uploaded = await metaClient.uploadMedia(waba.phone_number_id, accessToken, req.file.buffer, mimeType, req.file.originalname);
  } catch (err) {
    return res.status(502).json({ error: 'Could not upload media to Meta', detail: describeMetaError(err), metaError: err.metaError || undefined });
  }

  req.db = await req.reacquireDb();

  // Recommended (not required) by Meta for a document header send, same as
  // the approval-time seed in the POST / handler above - null for IMAGE/VIDEO.
  const filename = headerTypeForLimits === 'DOCUMENT' ? (req.file.originalname || null) : null;
  const asset = await templateMediaCacheRepo.insertAsset(req.db, req.clientId, template.id, { mediaId: uploaded.id, filename, cardIndex });
  res.status(201).json({ id: asset.id, filename: asset.filename, cardIndex: asset.card_index });
}));

// Lists every media row for a template, default first - the New Campaign
// modal's existing-asset picker (and any future caller) uses this instead
// of only ever being able to upload a brand new file, which was the only
// option before: a template synced in from Meta, or one with successfully
// uploaded assets that never got promoted to default, had usable media
// this app had no way to show or pick. cardIndex is included so a caller
// managing a carousel template's per-card media can group by it.
router.get('/:id/header-media', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const template = await messageTemplatesRepo.findById(req.db, req.clientId, req.params.id);
  if (!template) return res.status(404).json({ error: 'Not found' });
  const assets = await templateMediaCacheRepo.listByTemplateId(req.db, req.clientId, template.id);
  res.json(assets.map((a) => ({ id: a.id, filename: a.filename, isDefault: a.is_default, resolvedAt: a.resolved_at, cardIndex: a.card_index })));
}));

// Promotes an existing, already-uploaded asset to be this template's
// default - the fallback a plain send/broadcast resolves when no specific
// headerMediaAssetId is given (mediaHeaderService.resolveMediaId). Needed
// because POST /:id/header-media above always inserts a new NON-default
// asset (insertAsset) - there was previously no path at all to promote one.
router.post('/:id/header-media/:assetId/default', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  uuid.parse(req.params.assetId);
  const template = await messageTemplatesRepo.findById(req.db, req.clientId, req.params.id);
  if (!template) return res.status(404).json({ error: 'Not found' });
  const updated = await templateMediaCacheRepo.setDefault(req.db, req.clientId, template.id, req.params.assetId);
  if (!updated) return res.status(404).json({ error: 'Media asset not found for this template' });
  res.json({ id: updated.id, filename: updated.filename, isDefault: updated.is_default, cardIndex: updated.card_index });
}));

// Edits an existing template's content - body/header/footer/buttons/
// samples, or auth_options for Authentication. name/category/language are
// fixed once a template exists (Meta's own edit endpoint doesn't accept
// them either - they're what identifies the template in the first place).
// Two real states this acts on:
//  - meta_template_id set, not orphaned: the template is live on Meta -
//    this calls Meta's real "edit message template" endpoint, which
//    re-reviews the NEW content while the OLD approved content keeps
//    sending in the meantime (Meta's own documented behavior) - unlike
//    delete + recreate, there's no gap where the template is unsendable.
//  - no meta_template_id at all (a draft never submitted): pure local
//    edit, no Meta call - same as editing any other not-yet-submitted
//    draft would be.
// An orphaned row (was live, Meta no longer has it - see markOrphaned's
// comment) is rejected: there's nothing left on Meta to edit, and quietly
// re-creating it here would blur this route with POST /'s own job.
// Delete + recreate (DELETE /:id, then POST /) is still the path for that.
//
// Media-header edit (2026-11-23, closing a prior Known Gap): Meta's edit
// endpoint is a full-replace PATCH - this app's own edit flow already
// proved that for NONE/TEXT (every edit resends header explicitly, even as
// NONE, confirmed working since the edit feature shipped). A media header
// component needs a fresh upload handle every time (buildTemplateCreatePayload),
// and a handle's lifetime past its one upload session is undocumented by
// Meta (see the media-header investigation referenced elsewhere in this
// codebase) - so rather than guess whether an old handle (or the cached
// media id, which is a send-time reference, not a template-definition one)
// can be resent, this route always requires a FRESH file upload whenever
// the saved OR requested header.type is a media type, using the exact same
// createUploadSession/uploadFileBytes/uploadMedia dance POST / already
// uses and has verified. This means editing so much as the footer on a
// media-header template still requires re-selecting its file - a real UX
// cost, but an honest one: it never assumes undocumented Meta behavior.
router.put('/:id', requireRole('Admin', 'Manager'), uploadTemplateMedia, asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const template = await messageTemplatesRepo.findById(req.db, req.clientId, req.params.id);
  if (!template) return res.status(404).json({ error: 'Not found' });

  if (template.orphaned_at) {
    return res.status(400).json({
      error: 'Cannot edit - no longer on Meta',
      detail: 'This template is no longer live on Meta (see the "not found on Meta" note on its card) - there\'s nothing there to edit. Delete it and create a fresh one instead.',
    });
  }

  const headerFile = req.files?.headerFile?.[0];
  let rawBody = req.body;
  if (headerFile) {
    try {
      rawBody = JSON.parse(req.body.data || '{}');
    } catch (err) {
      return res.status(400).json({ error: 'Malformed request', detail: 'The "data" field must be valid JSON.' });
    }
  }
  const data = messageTemplateUpdateSchema.parse(rawBody);
  const isMediaHeader = mediaHeaderService.isMediaHeaderType(data.header?.type);

  if (template.category === 'Authentication') {
    if (data.body || data.header || data.footer || data.buttons) {
      return res.status(400).json({
        error: 'Authentication templates cannot have a custom body, header, footer, or buttons - Meta generates that text automatically.',
      });
    }
  } else {
    if (!data.body) {
      return res.status(400).json({ error: 'Invalid template body', details: ['Body is required.'] });
    }
    const validationError = validateStandardTemplateFields(data);
    if (validationError) return res.status(validationError.status).json(validationError.body);

    if (isMediaHeader) {
      const limits = MEDIA_HEADER_LIMITS[data.header.type];
      if (!headerFile) {
        return res.status(400).json({
          error: 'Missing header media',
          detail: `An ${data.header.type.toLowerCase()} file is required to save this template - Meta's edit endpoint needs a fresh upload every time, even if the picture isn't changing.`,
        });
      }
      const mimeType = limits.mimeTypes[headerFile.mimetype];
      if (!mimeType) {
        return res.status(400).json({
          error: 'Unsupported file type',
          detail: `${data.header.type} headers accept: ${Object.keys(limits.mimeTypes).join(', ')}.`,
        });
      }
      if (headerFile.size > limits.maxBytes) {
        return res.status(400).json({
          error: 'File too large',
          detail: `${data.header.type} headers are limited to ${Math.round(limits.maxBytes / (1024 * 1024))}MB.`,
        });
      }
    }
  }

  // buildTemplateCreatePayload (used by metaClient.updateMessageTemplate)
  // needs the full shape it already validates for create - name/category/
  // language come from the existing row since the edit schema doesn't
  // carry them at all.
  const templateData = { ...data, name: template.name, category: template.category, language: template.language };

  let seededMedia = null;

  if (template.meta_template_id) {
    const waba = await wabasRepo.findByClientId(req.clientId);
    if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) {
      return res.status(400).json({
        error: 'Cannot edit on Meta',
        detail: 'This template is live on Meta, but WhatsApp isn\'t connected right now - reconnect before editing.',
      });
    }

    let accessToken;
    try {
      accessToken = decrypt(waba.access_token_encrypted);
    } catch (err) {
      return res.status(500).json({
        error: 'Could not decrypt this WABA\'s access token',
        detail: 'SERVER_SECRET in this environment does not match the key that encrypted the stored token.',
      });
    }

    // Same reasoning as POST /'s commitAndRelease - this Meta edit call
    // (plus, now, a possible media upload first) can take seconds; don't
    // pin a tenant connection idle-in-transaction for it. A rejection below
    // returns straight away with no further req.db use, so only the
    // success path needs to reacquire before updateContent.
    await req.commitAndRelease();

    if (isMediaHeader) {
      if (!process.env.META_APP_ID) {
        return res.status(502).json({ error: 'META_APP_ID is not configured for this environment' });
      }
      const mimeType = MEDIA_HEADER_LIMITS[data.header.type].mimeTypes[headerFile.mimetype];
      try {
        const uploaded = await mediaHeaderService.uploadTemplateHeaderMedia(waba, accessToken, data.header.type, headerFile, mimeType);
        templateData.header.handle = uploaded.handle;
        seededMedia = uploaded.seededMedia;
      } catch (err) {
        return res.status(502).json({ error: 'Could not upload header media to Meta', detail: describeMetaError(err), metaError: err.metaError || undefined });
      }
    }

    try {
      await metaClient.updateMessageTemplate(template.meta_template_id, accessToken, templateData);
    } catch (err) {
      if (err instanceof metaClient.TemplateValidationError) {
        return res.status(400).json({ error: 'Invalid template', details: err.errors });
      }
      return res.status(502).json({ error: 'Meta rejected this edit', detail: describeMetaError(err), metaError: err.metaError || undefined });
    }

    req.db = await req.reacquireDb();
  }

  const updated = await messageTemplatesRepo.updateContent(req.db, req.clientId, template.id, templateData);
  if (seededMedia) {
    // Replaces this template's default media cache row (upsert is keyed on
    // template_id + is_default, migration 030) with the asset just
    // uploaded - the picture that was actually resubmitted to Meta is the
    // one a future send should default to, not whatever was there before.
    await templateMediaCacheRepo.upsert(req.db, req.clientId, template.id, seededMedia);
  }
  // Same non-blocking signal as POST /'s - see that route's comment.
  const categoryCheck = checkCategoryContentMismatch(templateData.body, templateData.category);
  res.json(categoryCheck.mismatch ? { ...updated, warnings: [categoryCheck.warning] } : updated);
}));

// Deletes a template - on Meta first (when it was ever submitted there),
// then the local row, so the two never diverge (a client-visible "deleted"
// template still sitting live on Meta, sendable from Business Manager).
// meta_template_id is only null for a local draft never submitted (no WABA
// connected yet at creation) - nothing to delete on Meta's side for that
// case. orphaned_at means Meta already doesn't have it (confirmed by a
// prior sync - see templateSyncService.js), so the Meta call is skipped
// there too rather than erroring on a template that's already gone.
router.delete('/:id', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const template = await messageTemplatesRepo.findById(req.db, req.clientId, req.params.id);
  if (!template) return res.status(404).json({ error: 'Not found' });

  if (template.meta_template_id && !template.orphaned_at) {
    const waba = await wabasRepo.findByClientId(req.clientId);
    if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) {
      return res.status(400).json({
        error: 'Cannot delete on Meta',
        detail: 'This template was submitted to Meta, but WhatsApp isn\'t connected right now - reconnect before deleting so it isn\'t left behind live on Meta.',
      });
    }

    let accessToken;
    try {
      accessToken = decrypt(waba.access_token_encrypted);
    } catch (err) {
      return res.status(500).json({
        error: 'Could not decrypt this WABA\'s access token',
        detail: 'SERVER_SECRET in this environment does not match the key that encrypted the stored token.',
      });
    }

    // Same reasoning as POST /'s commitAndRelease. Reacquire happens once,
    // after the try/catch, regardless of whether the Meta call succeeded or
    // was the "already gone" caught-and-ignored case - both fall through to
    // the same local delete below and need a live connection for it; only
    // the real-rejection path returns early with no further req.db use.
    await req.commitAndRelease();

    try {
      await metaClient.deleteMessageTemplate(waba.waba_id, accessToken, template.name, template.meta_template_id);
    } catch (err) {
      // Meta errors out if the template is already gone there (deleted
      // directly in Business Manager since the last sync) - treated as
      // success rather than blocking the local delete on a template that
      // no longer exists to delete.
      const alreadyGone = /does not exist|cannot be found|no longer exists/i.test(err.message || '');
      if (!alreadyGone) {
        return res.status(502).json({ error: 'Could not delete template on Meta', detail: describeMetaError(err), metaError: err.metaError || undefined });
      }
    }

    req.db = await req.reacquireDb();
  }

  await messageTemplatesRepo.remove(req.db, req.clientId, template.id);
  res.status(204).send();
}));

module.exports = router;
