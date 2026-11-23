// Integrations page (build-docs/features/integrations-page.md): one read-only
// view of the integrations that already work elsewhere in the app. No new
// connector here, and never a secret: no webhook secret, key hash, raw key or
// subscription secret is selected, let alone returned.
const { Router } = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireRole } = require('../middleware/requireRole');

const router = Router();
router.use(requireRole('Admin', 'Manager'));

// Latest delivery to any of `urls` (webhook_deliveries has no "integration"
// column; the destination URL is what tells the hub/webhook/Zapier apart).
async function lastDelivery(db, clientId, urls) {
  if (!urls.length) return null;
  const { rows } = await db.query(
    `select status, created_at, delivered_at, last_error from webhook_deliveries
     where client_id = $1 and target_url = any($2::text[])
     order by created_at desc limit 1`,
    [clientId, urls]
  );
  const d = rows[0];
  return d ? { status: d.status, at: d.delivered_at || d.created_at, error: d.status === 'failed' ? d.last_error : null } : null;
}

router.get('/status', asyncHandler(async (req, res) => {
  const { db, clientId } = req;
  const [waba, hook, zaps, keys, links] = await Promise.all([
    db.query(`select 1 from wabas where client_id = $1 and status = 'connected' limit 1`, [clientId]),
    db.query('select callback_url, events from client_webhooks where client_id = $1', [clientId]),
    db.query('select target_url from zapier_subscriptions where client_id = $1', [clientId]),
    db.query(
      `select count(*)::int as active, max(last_used_at) as last_used_at from api_keys
       where client_id = $1 and revoked_at is null and deleted_at is null`,
      [clientId]
    ),
    db.query('select count(*)::int as n, max(created_at) as last_at from payment_links where client_id = $1', [clientId]),
  ]);
  const webhook = hook.rows[0];
  const zapUrls = [...new Set(zaps.rows.map((r) => r.target_url))];
  res.json({
    whatsappConnected: waba.rows.length > 0,
    webhook: {
      configured: Boolean(webhook?.callback_url),
      events: webhook?.events || [],
      lastDelivery: await lastDelivery(db, clientId, webhook?.callback_url ? [webhook.callback_url] : []),
    },
    zapier: { activeZaps: zaps.rows.length, lastDelivery: await lastDelivery(db, clientId, zapUrls) },
    api: { activeKeys: keys.rows[0].active, lastUsedAt: keys.rows[0].last_used_at },
    paymentLinks: { created: links.rows[0].n, lastCreatedAt: links.rows[0].last_at },
  });
}));

module.exports = router;
