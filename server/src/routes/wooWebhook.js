// Public WooCommerce endpoints (build-docs/features/woocommerce-integration.md).
// No client auth: the auth callback is matched by its one-time connect token,
// order webhooks by the per-store HMAC signature. Privileged pool throughout;
// every write is scoped to the store's own client_id.
const { Router } = require('express');
const { pool } = require('../db/pool');
const { asyncHandler } = require('../utils/asyncHandler');
const ecommerceRepo = require('../repositories/ecommerceRepo');
const ecommerceService = require('../services/ecommerceService');

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// WooCommerce's one-click approval POSTs { key_id, user_id, consumer_key,
// consumer_secret, key_permissions } here. user_id is our connect token.
router.post('/auth-callback', asyncHandler(async (req, res) => {
  const { user_id: token, consumer_key: key, consumer_secret: secret } = req.body || {};
  if (typeof token !== 'string' || token.length < 20 || typeof key !== 'string' || typeof secret !== 'string') {
    return res.status(400).json({ error: 'Invalid callback' });
  }
  const store = await ecommerceRepo.findStoreByConnectToken(pool, token);
  if (!store) return res.status(400).json({ error: 'Unknown or already used connection request' });
  try {
    await ecommerceService.finishConnect(pool, store, { consumerKey: key, consumerSecret: secret });
  } catch (err) {
    // Recorded on the store (status 'error'); the client sees it on the page.
    console.error('woocommerce: finishing connection failed', { storeId: store.id, error: err.message });
  }
  res.status(200).json({ ok: true });
}));

router.post('/:storeId', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.storeId)) return res.status(404).end();
  const store = await ecommerceRepo.findStoreById(pool, req.params.storeId);
  if (!store || store.status !== 'connected') return res.status(404).end();

  // Sent once when the webhook is created: a form body "webhook_id=<id>", unsigned.
  if (!req.get('x-wc-webhook-topic') && req.body?.webhook_id) return res.status(200).end();

  if (!ecommerceService.verifySignature(store, req.rawBody, req.get('x-wc-webhook-signature'))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const topic = req.get('x-wc-webhook-topic');
  // Answer first: WooCommerce times out slow webhooks and eventually disables
  // them. handleWooEvent never throws and records every outcome.
  res.status(200).end();
  if (ecommerceService.WEBHOOK_TOPICS.includes(topic)) {
    setImmediate(() => { ecommerceService.handleWooEvent(store, topic, req.body); });
  }
}));

module.exports = router;
