// Hub template API (build plan Phase 5) — same auth model and the same
// creation path as routes/templates.js (named-parameter validation, the
// params-words-ratio rule, and the real Meta submission when a WABA is
// connected all live in messageTemplatesRepo/metaClient and are reused
// as-is here, not reimplemented). Unlike the send endpoint, there's no
// client_id field in the body — the API key already resolves to exactly
// one client, and a template has no separate "who is this for" concept the
// way a message's `to` does.
const { Router } = require('express');
const { pool } = require('../db/pool');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const wabasRepo = require('../repositories/wabasRepo');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');
const { asyncHandler } = require('../utils/asyncHandler');
const { messageTemplateCreateSchema, uuid } = require('../utils/validate');
const { validateTemplateText } = require('../utils/templateParams');
const { requireApiKey } = require('../middleware/requireApiKey');

const router = Router();
router.use(requireApiKey);

router.get('/', asyncHandler(async (req, res) => {
  res.json(await messageTemplatesRepo.listByClientId(pool, req.clientId));
}));

// get_template_details (MCP tool inventory) — full stored shape (body,
// header, footer, buttons, bodyParamExamples) so a caller knows exactly
// what parameters a template needs before sending it, not just its
// approval status.
router.get('/:id', asyncHandler(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const template = await messageTemplatesRepo.findById(pool, req.clientId, id);
  if (!template) return res.status(404).json({ error: 'Not found' });
  res.json(template);
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = messageTemplateCreateSchema.parse(req.body);

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
      return res.status(502).json({ error: 'Meta rejected this template', detail: err.message, metaError: err.metaError || undefined });
    }
  }

  const template = await messageTemplatesRepo.create(pool, { client_id: req.clientId, ...data, status: 'pending' });
  res.status(201).json(template);
}));

module.exports = router;
