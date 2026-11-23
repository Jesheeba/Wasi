// WooCommerce integration logic (build-docs/features/woocommerce-integration.md).
const crypto = require('crypto');
const { pool } = require('../db/pool');
const ecommerceRepo = require('../repositories/ecommerceRepo');
const contactsRepo = require('../repositories/contactsRepo');
const chatsRepo = require('../repositories/chatsRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const messagingService = require('./messagingService');
const metaClient = require('../utils/metaClient');
const wooClient = require('./wooClient');
const woo = require('../utils/wooOrders');
const { extractPlaceholders } = require('../utils/templateParams');
const { encrypt, decrypt } = require('../utils/encryption');

const WEBHOOK_TOPICS = ['order.created', 'order.updated'];

// WooCommerce must be able to reach this server over https.
function publicBaseUrl() {
  const base = String(process.env.APP_URL || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) {
    throw new Error('This Wasi server has no public https address (APP_URL), so WooCommerce cannot send it events.');
  }
  return base;
}
const webhookUrl = (storeId) => `${publicBaseUrl()}/webhooks/woocommerce/${storeId}`;
const authCallbackUrl = () => `${publicBaseUrl()}/webhooks/woocommerce/auth-callback`;

function authorizeUrl(store) {
  const q = new URLSearchParams({
    app_name: 'Wasi',
    scope: 'read_write',
    user_id: store.connect_token,
    return_url: `${publicBaseUrl()}/app#ecommerce`,
    callback_url: authCallbackUrl(),
  });
  return `${store.store_url}/wc-auth/v1/authorize?${q}`;
}

const keysOf = (store) => ({
  url: store.store_url,
  key: decrypt(store.consumer_key_encrypted),
  secret: decrypt(store.consumer_secret_encrypted),
});

// Verifies the keys, (re)creates both webhooks with a fresh secret, and marks
// the store connected. On any failure the store is marked 'error' with the
// reason, the keys are kept (so a retry needs no new approval) and the error
// is rethrown for the caller to report.
async function finishConnect(db, store, { consumerKey, consumerSecret }) {
  const creds = { url: store.store_url, key: consumerKey, secret: consumerSecret };
  const webhookSecret = crypto.randomBytes(24).toString('hex');
  await ecommerceRepo.updateStore(db, store.client_id, store.id, {
    consumer_key_encrypted: encrypt(consumerKey),
    consumer_secret_encrypted: encrypt(consumerSecret),
    connect_token: null,
  });
  try {
    await wooClient.verifyAccess(creds);
    const ids = [];
    for (const topic of WEBHOOK_TOPICS) {
      ids.push(await wooClient.createWebhook(creds, { topic, deliveryUrl: webhookUrl(store.id), secret: webhookSecret }));
    }
    return await ecommerceRepo.updateStore(db, store.client_id, store.id, {
      status: 'connected', webhook_ids: ids, webhook_secret_encrypted: encrypt(webhookSecret), last_error: null,
    });
  } catch (err) {
    await ecommerceRepo.updateStore(db, store.client_id, store.id, { status: 'error', last_error: err.message });
    throw err;
  }
}

async function disconnect(db, store) {
  if (store.consumer_key_encrypted && Array.isArray(store.webhook_ids)) {
    const creds = keysOf(store);
    for (const id of store.webhook_ids) {
      try { await wooClient.deleteWebhook(creds, id); } catch (err) {
        console.error('ecommerce: removing a WooCommerce webhook failed (continuing):', err.message);
      }
    }
  }
  await ecommerceRepo.deleteStore(db, store.client_id, store.id);
}

function verifySignature(store, rawBody, signature) {
  if (!store.webhook_secret_encrypted || !rawBody || !signature) return false;
  const expected = crypto.createHmac('sha256', decrypt(store.webhook_secret_encrypted)).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A template a rule may use: approved, Utility, and every variable known.
// Returns { template, variables, headerVariables } or { error }.
async function resolveRuleTemplate(db, clientId, name) {
  const template = await messageTemplatesRepo.findByNameAndClient(db, clientId, name);
  if (!template) return { error: `Template "${name}" was not found. Sync your templates first.` };
  if (String(template.category).toLowerCase() !== 'utility') {
    return { error: 'Order messages must use a Utility template. Marketing templates need the customer\'s opt-in.' };
  }
  if (template.status !== 'approved') return { error: `Template "${name}" is not approved by WhatsApp yet.` };
  const variables = [...new Set(extractPlaceholders(template.body).map((p) => p.name))];
  const headerVariables = template.header_type === 'TEXT'
    ? [...new Set(extractPlaceholders(template.header_content).map((p) => p.name))]
    : [];
  return { template, variables, headerVariables };
}

// One WooCommerce order event, on the privileged pool. Never throws: every
// outcome is recorded on the event row so the client can see what happened.
async function handleWooEvent(store, topic, order) {
  const clientId = store.client_id;
  const t = woo.triggerFor(topic, order);
  if (!t) return null;
  const fields = woo.fieldsFromOrder(order);
  const { phone, reason } = woo.normalizePhone(order.billing?.phone, order.billing?.country);
  const event = await ecommerceRepo.claimEvent(pool, {
    clientId, storeId: store.id, trigger: t.trigger, dedupeKey: t.dedupeKey,
    orderNumber: fields.order_number, customerName: fields.customer_name, phone,
  });
  if (!event) return null; // already handled
  await ecommerceRepo.updateStore(pool, clientId, store.id, { last_event_at: new Date().toISOString() });
  const finish = (status, detail, messageId) => ecommerceRepo.finishEvent(pool, clientId, event.id, { status, detail, messageId });

  try {
    const rule = await ecommerceRepo.findRule(pool, clientId, store.id, t.trigger);
    if (!rule || !rule.enabled) return await finish('no_rule', 'No message is set up for this event');
    if (!phone) return await finish('skipped', reason);

    const resolved = await resolveRuleTemplate(pool, clientId, rule.template_name);
    if (resolved.error) return await finish('failed', resolved.error);
    const body = woo.buildParamValues(resolved.variables, rule.param_map, fields);
    const header = woo.buildParamValues(resolved.headerVariables, rule.param_map, fields);
    const missing = [...body.missing, ...header.missing];
    if (missing.length) return await finish('failed', `Template variable(s) not mapped to an order field: ${missing.join(', ')}`);

    const contact = await contactsRepo.upsertByPhone(pool, clientId, { phone, name: fields.customer_name });
    if (contact.opt_in_status === 'opted_out') return await finish('skipped', 'Customer has opted out of WhatsApp messages (sent STOP)');
    const chat = await chatsRepo.findOrCreateByContact(pool, clientId, contact);
    const message = await messagingService.sendChatMessage(pool, clientId, chat, {
      type: 'template',
      templateName: resolved.template.name,
      templateLanguage: resolved.template.language,
      templateComponents: [
        ...metaClient.buildNamedHeaderComponents(header.values),
        ...metaClient.buildNamedBodyComponents(body.values),
      ],
    });
    return await finish(message?.status === 'failed' ? 'failed' : 'sent', message?.error_reason || null, message?.id);
  } catch (err) {
    console.error('ecommerce: order event failed', { clientId, storeId: store.id, trigger: t.trigger, error: err.message });
    try { await finish('failed', err.message); } catch { /* best effort */ }
    return null;
  }
}

module.exports = { authorizeUrl, finishConnect, disconnect, verifySignature, resolveRuleTemplate, handleWooEvent, keysOf, WEBHOOK_TOPICS };
