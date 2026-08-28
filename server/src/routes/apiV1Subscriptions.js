// Zapier REST Hook subscribe/unsubscribe (build plan Phase 4,
// wasi-master-plan.md §3.1) — backs the Zapier app's "New WhatsApp Message
// Received" trigger (zapier-app/triggers/newMessageReceived.js). Zapier
// calls POST / when a user turns a Zap on (registering its own callback URL
// to receive future events) and DELETE /:id when they turn it off. This
// endpoint does no delivery itself — routes/metaWebhook.js's enqueueForwards
// is what actually enqueues events to the row created here, using the exact
// same webhook_deliveries queue + forwardRunner.js as every other forward
// target (see migration 040_zapier_subscriptions.js's comment).
//
// Same requireApiKey + privileged `pool` shape as the rest of the Hub API —
// the target_url a client's own Zap subscribes is scoped to req.clientId,
// req.apiKeyId (from the bearer key that authenticated this request), never
// a client-supplied id.
const { Router } = require('express');
const { pool } = require('../db/pool');
const zapierSubscriptionsRepo = require('../repositories/zapierSubscriptionsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { zapierSubscribeSchema, uuid } = require('../utils/validate');
const { requireApiKey } = require('../middleware/requireApiKey');
const { sendApiError } = require('../utils/apiError');

const router = Router();
router.use(requireApiKey);

router.post('/', asyncHandler(async (req, res) => {
  const { target_url, event } = zapierSubscribeSchema.parse(req.body);
  const subscription = await zapierSubscriptionsRepo.create(pool, req.clientId, req.apiKeyId, target_url, event);
  // secret is returned once here, for the Zapier app to store alongside the
  // subscription id and verify the x-wasi-signature-256 header on each
  // delivery — same "show once, hash/store only what's needed to verify
  // later" shape as every other generated secret in this codebase.
  res.status(201).json(subscription);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const removed = await zapierSubscriptionsRepo.remove(pool, req.clientId, id);
  if (!removed) return sendApiError(res, 404, 'subscription_not_found', 'Not found.');
  res.json({ ok: true });
}));

module.exports = router;
