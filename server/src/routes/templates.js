const { Router } = require('express');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const wabasRepo = require('../repositories/wabasRepo');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');
const { asyncHandler } = require('../utils/asyncHandler');
const { messageTemplateCreateSchema } = require('../utils/validate');
const { validateTemplateText } = require('../utils/templateParams');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await messageTemplatesRepo.listByClientId(req.db, req.clientId));
}));

// Submits to Meta for real approval when a WABA is connected — approval
// status then arrives asynchronously via the message_template_status_update
// webhook (server/src/routes/metaWebhook.js), same as it does for templates
// created directly in Meta Business Manager. Without a connected WABA yet,
// still saves locally as 'pending' so template drafting isn't blocked on
// onboarding order (spec allows connecting WhatsApp after initial signup).
router.post('/', asyncHandler(async (req, res) => {
  const data = messageTemplateCreateSchema.parse(req.body);

  // Validated up front, regardless of WABA connection state, so a template
  // using numbered {{1}}/{{2}} parameters (which Meta now rejects) never
  // gets silently saved as 'pending' without telling the author it's broken.
  const validation = validateTemplateText(data.body, { label: 'Body' });
  if (!validation.valid) {
    return res.status(400).json({ error: 'Invalid template body', details: validation.errors });
  }

  const waba = await wabasRepo.findByClientId(req.clientId);

  if (waba && waba.status === 'connected' && waba.access_token_encrypted) {
    try {
      const accessToken = decrypt(waba.access_token_encrypted);
      await metaClient.createMessageTemplate(waba.waba_id, accessToken, data);
    } catch (err) {
      if (err instanceof metaClient.TemplateValidationError) {
        return res.status(400).json({ error: 'Invalid template body', details: err.errors });
      }
      return res.status(502).json({ error: 'Meta rejected this template', detail: err.message });
    }
  }

  const template = await messageTemplatesRepo.create(req.db, { client_id: req.clientId, ...data, status: 'pending' });
  res.status(201).json(template);
}));

module.exports = router;
