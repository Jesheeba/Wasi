// Hub template API (build plan Phase 5) - same auth model and the same
// creation path as routes/templates.js (named-parameter validation, the
// params-words-ratio rule, and the real Meta submission when a WABA is
// connected all live in messageTemplatesRepo/metaClient and are reused
// as-is here, not reimplemented). Unlike the send endpoint, there's no
// client_id field in the body - the API key already resolves to exactly
// one client, and a template has no separate "who is this for" concept the
// way a message's `to` does.
//
// Media headers (IMAGE/VIDEO/DOCUMENT): the file comes either as a
// multipart `file` part (template JSON in a `data` field, same shape as
// the CRM's own create route) or as `headerMediaUrl` in a plain JSON body
// (a public https URL Wasi downloads, SSRF-guarded). Both go through the
// same two Meta uploads the CRM route uses
// (mediaHeaderService.uploadTemplateHeaderMedia), and the send-time media
// id is cached so the template is sendable the moment Meta approves it.
const { Router } = require('express');
const multer = require('multer');
const { pool } = require('../db/pool');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const { mapMetaCategory, categoryChangeWarning } = require('../services/templateSyncService');
const templateMediaCacheRepo = require('../repositories/templateMediaCacheRepo');
const wabasRepo = require('../repositories/wabasRepo');
const metaClient = require('../utils/metaClient');
const mediaHeaderService = require('../services/mediaHeaderService');
const { decrypt } = require('../utils/encryption');
const { asyncHandler } = require('../utils/asyncHandler');
const { messageTemplateCreateSchema, uuid } = require('../utils/validate');
const { validateTemplateText } = require('../utils/templateParams');
const { requireApiKey } = require('../middleware/requireApiKey');
const { sendApiError } = require('../utils/apiError');

const router = Router();
router.use(requireApiKey);

const { MEDIA_HEADER_LIMITS } = mediaHeaderService;
// Hard backstop only (largest type); checkHeaderFile enforces the per-type
// limit with a specific message.
const uploadFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEDIA_HEADER_LIMITS.DOCUMENT.maxBytes },
}).single('file');

// Meta's error_user_title/error_user_msg are more specific than the flat
// message (same helper as routes/templates.js).
function describeMetaError(err) {
  const meta = err.metaError;
  if (meta && (meta.error_user_title || meta.error_user_msg)) {
    return [meta.error_user_title, meta.error_user_msg].filter(Boolean).join(' - ');
  }
  return err.message;
}

router.get('/', asyncHandler(async (req, res) => {
  res.json(await messageTemplatesRepo.listByClientId(pool, req.clientId));
}));

// get_template_details (MCP tool inventory) - full stored shape (body,
// header, footer, buttons, bodyParamExamples) so a caller knows exactly
// what parameters a template needs before sending it, not just its
// approval status.
router.get('/:id', asyncHandler(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const template = await messageTemplatesRepo.findById(pool, req.clientId, id);
  if (!template) return sendApiError(res, 404, 'template_not_found', 'Not found.');
  res.json(template);
}));

router.post('/', uploadFile, asyncHandler(async (req, res) => {
  let rawBody = req.body;
  if (req.file) {
    try {
      rawBody = JSON.parse(req.body.data || '{}');
    } catch {
      return sendApiError(res, 400, 'invalid_request', 'The "data" field must be valid JSON when a file is uploaded.');
    }
  }
  const headerMediaUrl = rawBody?.headerMediaUrl;
  const data = messageTemplateCreateSchema.parse(rawBody);

  const validation = validateTemplateText(data.body, { label: 'Body' });
  if (!validation.valid) {
    return sendApiError(res, 400, 'invalid_template_body', 'Invalid template body.', { details: validation.errors });
  }

  const isMediaHeader = mediaHeaderService.isMediaHeaderType(data.header?.type);
  if (!isMediaHeader && (req.file || headerMediaUrl)) {
    return sendApiError(res, 400, 'unexpected_header_media', 'A file or headerMediaUrl was sent, but header.type is not IMAGE, VIDEO or DOCUMENT.');
  }
  if (req.file && headerMediaUrl) {
    return sendApiError(res, 400, 'invalid_request', 'Send either a file or headerMediaUrl, not both.');
  }
  if (isMediaHeader && !req.file && !headerMediaUrl) {
    return sendApiError(res, 400, 'header_media_required', `A ${data.header.type.toLowerCase()} header needs the file: upload it as multipart "file" (template JSON in "data"), or pass a public https URL as "headerMediaUrl".`);
  }
  if (req.file) {
    const check = mediaHeaderService.checkHeaderFile(data.header.type, req.file);
    if (check.error) return sendApiError(res, 400, 'invalid_header_media', `${check.error}: ${check.detail}`);
  }

  const waba = await wabasRepo.findByClientId(req.clientId);
  const connected = Boolean(waba && waba.status === 'connected' && waba.access_token_encrypted);

  if (isMediaHeader && !connected) {
    return sendApiError(res, 409, 'whatsapp_not_connected', 'A media header has to be uploaded to the connected WhatsApp number - connect WhatsApp before creating this template.');
  }

  let metaTemplateId = null;
  let metaCategory = null; // Meta's category in its create response - may differ from the submitted one
  let seededMedia = null;

  if (connected) {
    // Meta scopes a template to (name, language) per WABA; a second
    // submission isn't rejected, it sits in review indefinitely (same
    // check as routes/templates.js).
    const collisions = await messageTemplatesRepo.findActiveByNameAndLanguage(pool, req.clientId, data.name, data.language);
    if (collisions.length > 0) {
      return sendApiError(res, 409, 'template_name_taken', `A template named "${data.name}" in ${data.language} already exists on this WhatsApp number (currently ${collisions[0].status}). Use a different name, or delete the existing one first.`);
    }

    let accessToken;
    try {
      accessToken = decrypt(waba.access_token_encrypted);
    } catch {
      return sendApiError(res, 500, 'token_decrypt_failed', 'Could not decrypt this WhatsApp connection\'s access token - the request never reached Meta.');
    }

    if (isMediaHeader) {
      let file = req.file;
      if (!file) {
        try {
          file = await mediaHeaderService.fetchPublicMediaFile(headerMediaUrl, data.header.type);
        } catch (err) {
          if (err instanceof mediaHeaderService.MediaResolutionError) {
            return sendApiError(res, 400, 'invalid_header_media', err.message);
          }
          throw err;
        }
      }
      const mimeType = MEDIA_HEADER_LIMITS[data.header.type].mimeTypes[file.mimetype];
      try {
        const uploaded = await mediaHeaderService.uploadTemplateHeaderMedia(waba, accessToken, data.header.type, file, mimeType);
        data.header.handle = uploaded.handle;
        seededMedia = uploaded.seededMedia;
      } catch (err) {
        return sendApiError(res, 502, 'header_media_upload_failed', 'Could not upload the header media to Meta.', {
          detail: describeMetaError(err),
          metaError: err.metaError || undefined,
        });
      }
    }

    try {
      const metaResponse = await metaClient.createMessageTemplate(waba.waba_id, accessToken, data);
      metaTemplateId = metaResponse?.id || null;
      metaCategory = metaResponse?.category ? mapMetaCategory(metaResponse.category) : null;
    } catch (err) {
      if (err instanceof metaClient.TemplateValidationError) {
        return sendApiError(res, 400, 'invalid_template_body', 'Invalid template body.', { details: err.errors });
      }
      return sendApiError(res, 502, 'meta_template_rejected', 'Meta rejected this template.', {
        detail: describeMetaError(err),
        metaError: err.metaError || undefined,
      });
    }
  }

  let template = await messageTemplatesRepo.create(pool, { client_id: req.clientId, ...data, status: 'pending', meta_template_id: metaTemplateId });
  if (metaCategory && metaCategory !== template.category) {
    template = (await messageTemplatesRepo.applyMetaCategory(pool, template.id, metaCategory)) || template;
  }
  if (seededMedia) {
    await templateMediaCacheRepo.upsert(pool, req.clientId, template.id, seededMedia);
  }
  const categoryWarning = categoryChangeWarning(template);
  res.status(201).json(categoryWarning ? { ...template, warnings: [categoryWarning] } : template);
}));

module.exports = router;
