// Phase 6 Part B — cross-tenant operational views for the super-admin role
// (routes/superAdminAuth.js issues the token, requireSuperAdminAuth guards
// every route below, mounted in app.js). Uses `pool` directly, never
// `req.db` — same privileged, cross-tenant connection as routes/admin.js,
// the webhook receiver, and the background runners (see migration
// 013_tenant_isolation.js's module comment, which names that exception
// list explicitly; this router joins it for the same reason: aggregating
// across every tenant's data is the entire point, and RLS would make that
// impossible rather than just inconvenient).
//
// Deliberately read-mostly: the only mutation anywhere in this file is
// POST /api-keys/:id/revoke, the one exception the spec named. No send, no
// template editing, no client editing — small blast radius if this account
// is misused out of hours.
const { Router } = require('express');
const { pool } = require('../db/pool');
const { z } = require('zod');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const apiKeysRepo = require('../repositories/apiKeysRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const { asyncHandler } = require('../utils/asyncHandler');

const router = Router();

// --- 1. Clients: tenant, WABA, phone number, connection status, plan, connected date ---
router.get('/clients', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    select c.id, c.name, c.email, c.status as client_status, c.tenant_slug, c.created_at as connected_date,
           w.waba_id, w.phone_number_id, w.status as waba_status, w.quality_rating,
           s.plan, s.status as subscription_status
    from clients c
    left join lateral (select * from wabas where client_id = c.id order by created_at desc limit 1) w on true
    left join lateral (select * from subscriptions where client_id = c.id order by created_at desc limit 1) s on true
    order by c.created_at desc
  `);
  res.json(rows);
}));

// --- 2. Health per client: quality rating, restriction status, last successful
// webhook, forwarding failure count. The daily-check screen. Messaging tier is
// deliberately absent — Meta's field/shape for it hasn't been confirmed
// against a live payload (same honesty standard metaWebhook.js's own
// handleUnmappedWabaEvent already uses), so it ships as "not yet available"
// rather than a guessed field that might silently never populate. ---
router.get('/health', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    select c.id as client_id, c.name as client_name, c.tenant_slug,
           w.id as waba_row_id, w.waba_id, w.status as waba_status,
           w.quality_rating, w.restriction_status,
           (select max(received_at) from meta_webhook_log
             where success = true and w.id = any(waba_ids_touched)) as last_successful_webhook_at,
           (select count(*)::int from webhook_deliveries wd
             where wd.waba_id = w.id and wd.status = 'failed') as forwarding_failure_count
    from clients c
    join wabas w on w.client_id = c.id
    order by c.name asc
  `);
  res.json(rows.map((r) => ({ ...r, messaging_tier: null })));
}));

// --- 3. Templates across all clients: status, rejection reasons, paused/disabled ---
router.get('/templates', asyncHandler(async (req, res) => {
  const TEMPLATE_STATUSES = ['approved', 'pending', 'rejected', 'paused', 'disabled', 'pending_deletion', 'in_appeal'];
  const status = TEMPLATE_STATUSES.includes(req.query.status) ? req.query.status : null;
  res.json(await messageTemplatesRepo.listAll(pool, status));
}));

// --- 4. Volume: sends per client per day ---
router.get('/volume', asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const { rows } = await pool.query(
    `select u.client_id, c.name as client_name, u.date, u.messages_sent, u.messages_received, u.conversations_billed
     from usage_logs u
     join clients c on c.id = u.client_id
     where u.date >= current_date - $1::int
     order by u.date desc, c.name asc`,
    [days]
  );
  res.json(rows);
}));

// --- 5. API keys: which app, which client, last used, revoke ---
router.get('/api-keys', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    select k.id, k.client_id, k.app_name, k.last_used_at, k.revoked_at, k.created_at, c.name as client_name
    from api_keys k join clients c on c.id = k.client_id
    order by k.created_at desc
  `);
  res.json(rows);
}));

router.post('/api-keys/:id/revoke', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const schema = z.object({ client_id: z.string().uuid() });
  const { client_id } = schema.parse(req.body);
  const revoked = await apiKeysRepo.revoke(pool, id, client_id);
  if (!revoked) return res.status(404).json({ error: 'Not found, or already revoked' });
  await auditLogRepo.record({ actor_type: 'super_admin', actor_id: req.superAdminId, action: 'api_key_revoked', target: id });
  res.json(revoked);
}));

// --- 6. Failures: failed sends with Meta error codes, webhook_deliveries in
// terminal failed state ---
router.get('/failures/sends', asyncHandler(async (req, res) => {
  const authOnly = req.query.auth_only === 'true';
  const { rows } = await pool.query(
    `select m.id, m.client_id, c.name as client_name, m.chat_id, m.body, m.error_reason, m.meta_error_code, m.sent_at
     from messages m
     join clients c on c.id = m.client_id
     where m.status = 'failed' and ($1::boolean = false or m.meta_error_code in (190, 10))
     order by m.sent_at desc
     limit 200`,
    [authOnly]
  );
  res.json(rows);
}));

router.get('/failures/webhook-deliveries', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    select wd.id, wd.client_id, c.name as client_name, wd.waba_id, wd.event, wd.target_url,
           wd.attempt_count, wd.last_error, wd.created_at
    from webhook_deliveries wd
    join clients c on c.id = wd.client_id
    where wd.status = 'failed'
    order by wd.created_at desc
    limit 200
  `);
  res.json(rows);
}));

module.exports = router;
