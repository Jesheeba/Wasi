const { Router } = require('express');
const crypto = require('crypto');
const clientWebhooksRepo = require('../repositories/clientWebhooksRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { clientWebhookSchema } = require('../utils/validate');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const webhook = await clientWebhooksRepo.findByClientId(req.db, req.clientId);
  // Secret is shown once at creation-equivalent time (every GET, since
  // there's no separate "reveal" step) — this is the client's own webhook
  // config, not a third-party secret, so that's an acceptable trade-off.
  res.json(webhook);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { callback_url } = clientWebhookSchema.parse(req.body);
  const existing = await clientWebhooksRepo.findByClientId(req.db, req.clientId);
  const secret = existing?.secret || crypto.randomBytes(24).toString('hex');
  const saved = await clientWebhooksRepo.upsert(req.db, req.clientId, callback_url, secret);
  res.json(saved);
}));

module.exports = router;
