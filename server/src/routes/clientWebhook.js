const { Router } = require('express');
const crypto = require('crypto');
const clientWebhooksRepo = require('../repositories/clientWebhooksRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { clientWebhookSchema } = require('../utils/validate');

const router = Router();

// Never put the raw secret in a response object literally — always build
// the masked shape below so a future field addition to `webhook` (a bare
// `select *`) can't silently start leaking it again through this route.
function maskWebhook(webhook) {
  if (!webhook) return null;
  const { secret, ...rest } = webhook;
  return { ...rest, has_secret: !!secret, secret_last4: secret ? secret.slice(-4) : null };
}

router.get('/', asyncHandler(async (req, res) => {
  const webhook = await clientWebhooksRepo.findByClientId(req.db, req.clientId);
  res.json(maskWebhook(webhook));
}));

router.post('/', asyncHandler(async (req, res) => {
  const { callback_url, events } = clientWebhookSchema.parse(req.body);
  const existing = await clientWebhooksRepo.findByClientId(req.db, req.clientId);
  const isNewSecret = !existing?.secret;
  const secret = existing?.secret || crypto.randomBytes(24).toString('hex');
  const saved = await clientWebhooksRepo.upsert(req.db, req.clientId, callback_url, secret, events);
  // Only a genuinely new secret (first-time setup) is ever returned raw —
  // saving the URL/events on top of an existing secret must not re-expose it.
  res.json(isNewSecret ? { ...maskWebhook(saved), secret } : maskWebhook(saved));
}));

// Separate, explicit action — force-generates a new secret even if one
// already exists, invalidating the old one immediately. The frontend must
// warn before calling this; it's not reachable from the regular save path.
router.post('/regenerate-secret', asyncHandler(async (req, res) => {
  const existing = await clientWebhooksRepo.findByClientId(req.db, req.clientId);
  if (!existing) return res.status(404).json({ error: 'No webhook configured yet' });
  const secret = crypto.randomBytes(24).toString('hex');
  const saved = await clientWebhooksRepo.regenerateSecret(req.db, req.clientId, secret);
  res.json({ ...maskWebhook(saved), secret });
}));

module.exports = router;
