// Ecommerce page API - WooCommerce (build-docs/features/woocommerce-integration.md).
// Admin/Manager only. Never returns a key, secret or connect token.
const crypto = require('crypto');
const { Router } = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireRole } = require('../middleware/requireRole');
const ecommerceRepo = require('../repositories/ecommerceRepo');
const ecommerceService = require('../services/ecommerceService');
const { assertPublicHttpsUrl } = require('../utils/publicUrl');
const woo = require('../utils/wooOrders');
const wabasRepo = require('../repositories/wabasRepo');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');

const router = Router();
router.use(requireRole('Admin', 'Manager'));

const shapeStore = (s) => s && ({
  id: s.id, platform: s.platform, storeUrl: s.store_url, status: s.status,
  lastEventAt: s.last_event_at, lastError: s.last_error, connectedSince: s.updated_at,
});

router.get('/woocommerce', asyncHandler(async (req, res) => {
  const store = await ecommerceRepo.findStoreByClient(req.db, req.clientId);
  const [rules, events] = store
    ? await Promise.all([ecommerceRepo.listRules(req.db, req.clientId, store.id), ecommerceRepo.listEvents(req.db, req.clientId, store.id)])
    : [[], []];
  res.json({
    store: shapeStore(store),
    triggers: woo.TRIGGERS,
    fields: woo.ORDER_FIELDS,
    rules: rules.map((r) => ({ trigger: r.trigger, templateName: r.template_name, paramMap: r.param_map, enabled: r.enabled })),
    events: events.map((e) => ({
      id: e.id, trigger: e.trigger, orderNumber: e.order_number, customerName: e.customer_name,
      phone: e.phone, status: e.status, detail: e.detail, createdAt: e.created_at,
    })),
  });
}));

async function startConnect(req, res, storeUrlInput) {
  let storeUrl;
  try {
    storeUrl = await assertPublicHttpsUrl(storeUrlInput);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return null;
  }
  const existing = await ecommerceRepo.findStoreByClient(req.db, req.clientId);
  if (existing?.status === 'connected') {
    res.status(409).json({ error: 'A store is already connected. Disconnect it first.' });
    return null;
  }
  return ecommerceRepo.upsertPendingStore(req.db, req.clientId, storeUrl, crypto.randomBytes(24).toString('hex'));
}

// One-click: returns WooCommerce's approval page URL. The store then POSTs
// the keys to /webhooks/woocommerce/auth-callback.
router.post('/woocommerce/connect', asyncHandler(async (req, res) => {
  const { storeUrl } = z.object({ storeUrl: z.string().min(1).max(500) }).parse(req.body);
  const store = await startConnect(req, res, storeUrl);
  if (!store) return;
  try {
    res.json({ authorizeUrl: ecommerceService.authorizeUrl(store) });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
}));

// Manual: the client pasted REST keys from WooCommerce > Settings > Advanced > REST API.
router.post('/woocommerce/keys', asyncHandler(async (req, res) => {
  const input = z.object({
    storeUrl: z.string().min(1).max(500),
    consumerKey: z.string().trim().regex(/^ck_[A-Za-z0-9]{20,64}$/, 'The consumer key starts with ck_'),
    consumerSecret: z.string().trim().regex(/^cs_[A-Za-z0-9]{20,64}$/, 'The consumer secret starts with cs_'),
  }).parse(req.body);
  const store = await startConnect(req, res, input.storeUrl);
  if (!store) return;
  try {
    const connected = await ecommerceService.finishConnect(req.db, store, { consumerKey: input.consumerKey, consumerSecret: input.consumerSecret });
    res.json({ store: shapeStore(connected) });
  } catch (err) {
    res.status(502).json({ error: 'Could not connect the store', detail: err.message });
  }
}));

router.delete('/woocommerce', asyncHandler(async (req, res) => {
  const store = await ecommerceRepo.findStoreByClient(req.db, req.clientId);
  if (!store) return res.status(404).json({ error: 'No store connected' });
  await ecommerceService.disconnect(req.db, store);
  res.status(204).send();
}));

// Template variables for a template, so the UI can show one mapping row each.
router.get('/woocommerce/template-variables', asyncHandler(async (req, res) => {
  const name = z.string().min(1).max(512).parse(req.query.name);
  const resolved = await ecommerceService.resolveRuleTemplate(req.db, req.clientId, name);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  res.json({ variables: [...resolved.headerVariables, ...resolved.variables] });
}));

router.put('/woocommerce/rules/:trigger', asyncHandler(async (req, res) => {
  const { trigger } = req.params;
  if (!woo.isTrigger(trigger)) return res.status(400).json({ error: 'Unknown order event' });
  const store = await ecommerceRepo.findStoreByClient(req.db, req.clientId);
  if (!store) return res.status(409).json({ error: 'Connect your store first.' });
  const input = z.object({
    templateName: z.string().min(1).max(512),
    paramMap: z.record(z.string()).default({}),
    enabled: z.boolean().default(true),
  }).parse(req.body);
  const resolved = await ecommerceService.resolveRuleTemplate(req.db, req.clientId, input.templateName);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const variables = [...resolved.headerVariables, ...resolved.variables];
  const unmapped = variables.filter((v) => !woo.isOrderField(input.paramMap[v]));
  if (unmapped.length) return res.status(400).json({ error: `Choose an order field for: ${unmapped.join(', ')}` });
  const paramMap = Object.fromEntries(variables.map((v) => [v, input.paramMap[v]]));
  const rule = await ecommerceRepo.upsertRule(req.db, req.clientId, store.id, { trigger, templateName: input.templateName, paramMap, enabled: input.enabled });
  res.json({ trigger: rule.trigger, templateName: rule.template_name, paramMap: rule.param_map, enabled: rule.enabled });
}));

router.delete('/woocommerce/rules/:trigger', asyncHandler(async (req, res) => {
  const store = await ecommerceRepo.findStoreByClient(req.db, req.clientId);
  if (!store) return res.status(404).json({ error: 'No store connected' });
  await ecommerceRepo.deleteRule(req.db, req.clientId, store.id, req.params.trigger);
  res.status(204).send();
}));

// ---------- Product messages: the Meta Commerce catalog ----------
// (build-docs/features/catalog-product-messages.md)
router.get('/catalog', asyncHandler(async (req, res) => {
  const waba = await wabasRepo.findByClientId(req.clientId);
  if (!waba || waba.status !== 'connected') return res.json({ connected: false, catalogId: null });
  res.json({ connected: true, catalogId: waba.commerce_catalog_id || null });
}));

router.put('/catalog', asyncHandler(async (req, res) => {
  const { catalogId } = z.object({ catalogId: z.string().trim().regex(/^\d{5,25}$/, 'A catalog ID is a long number from Commerce Manager').nullable() }).parse(req.body);
  const waba = await wabasRepo.findByClientId(req.clientId);
  if (!waba || waba.status !== 'connected') return res.status(409).json({ error: 'Connect your WhatsApp number first.' });
  await wabasRepo.setCommerceCatalogId(waba.id, catalogId);
  res.json({ catalogId });
}));

// Asks Meta which catalog is connected to the WABA. Meta lists
// catalog_management for this edge, which Wasi may not have; the reply then
// says so and the client types the ID instead.
router.post('/catalog/find', asyncHandler(async (req, res) => {
  const waba = await wabasRepo.findByClientId(req.clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) return res.status(409).json({ error: 'Connect your WhatsApp number first.' });
  let catalogs;
  try {
    catalogs = await metaClient.listWabaCatalogs(waba.waba_id, decrypt(waba.access_token_encrypted));
  } catch (err) {
    return res.status(502).json({ error: 'Meta did not share your catalog with Wasi. Copy the catalog ID from Commerce Manager and paste it instead.', detail: err.message });
  }
  if (!catalogs.length) return res.status(404).json({ error: 'No catalog is connected to your WhatsApp account. Connect one in WhatsApp Manager > Catalog first.' });
  res.json({ catalogs: catalogs.map((c) => ({ id: String(c.id), name: c.name || null })) });
}));

module.exports = router;
