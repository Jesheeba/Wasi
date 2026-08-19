const { Router } = require('express');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const wabasRepo = require('../repositories/wabasRepo');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');
const { asyncHandler } = require('../utils/asyncHandler');
const { messageTemplateCreateSchema } = require('../utils/validate');
const { validateTemplateText, validateHeaderText } = require('../utils/templateParams');
const templateSyncService = require('../services/templateSyncService');

const router = Router();

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
// onboarding order (spec allows connecting WhatsApp after initial signup).
router.post('/', asyncHandler(async (req, res) => {
  const data = messageTemplateCreateSchema.parse(req.body);

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
  }

  const waba = await wabasRepo.findByClientId(req.clientId);
  let metaTemplateId = null;

  if (waba && waba.status === 'connected' && waba.access_token_encrypted) {
    // Decryption failure is a distinct error class from Meta rejecting the
    // template — it means the request never reached Meta at all (wrong
    // SERVER_SECRET for this row's ciphertext, or a corrupted value).
    // Lumping it into "Meta rejected this template" is actively
    // misleading — it sends someone hunting for a content problem that
    // doesn't exist, when the real fix is a key/env mismatch.
    let accessToken;
    try {
      accessToken = decrypt(waba.access_token_encrypted);
    } catch (err) {
      return res.status(500).json({
        error: 'Could not decrypt this WABA\'s access token — the request never reached Meta',
        detail: 'SERVER_SECRET in this environment does not match the key that encrypted the stored token (a secret rotation, or a mismatch between local and production config).',
      });
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
  res.status(201).json(template);
}));

module.exports = router;
