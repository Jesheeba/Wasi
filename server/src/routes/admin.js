const { Router } = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const clientsRepo = require('../repositories/clientsRepo');
const wabasRepo = require('../repositories/wabasRepo');
const subscriptionsRepo = require('../repositories/subscriptionsRepo');
const plansRepo = require('../repositories/plansRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const supportTicketsRepo = require('../repositories/supportTicketsRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const adminUsersRepo = require('../repositories/adminUsersRepo');
const dataDeletionRequestsRepo = require('../repositories/dataDeletionRequestsRepo');
const apiKeysRepo = require('../repositories/apiKeysRepo');
const metaTemplateLibraryRepo = require('../repositories/metaTemplateLibraryRepo');
const metaTemplateLibraryRefreshRunner = require('../services/metaTemplateLibraryRefreshRunner');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');
const { hashPassword } = require('../utils/auth');
const { sendEmail } = require('../utils/emailService');
const { asyncHandler } = require('../utils/asyncHandler');
const { templateStatusUpdateSchema, ticketStatusUpdateSchema, hubForwardConfigSchema } = require('../utils/validate');
const { z } = require('zod');

const router = Router();

// Strips both secrets a wabas row can carry (Meta access token, hub-forward
// signing secret) from any response — used by every route that returns a
// waba row so a future added field can't reintroduce a leak by accident.
function maskWaba(waba) {
  if (!waba) return null;
  const { access_token_encrypted, forward_secret, ...rest } = waba;
  return { ...rest, has_forward_secret: !!forward_secret, forward_secret_last4: forward_secret ? forward_secret.slice(-4) : null };
}

// --- Overview / KPIs ---
router.get('/overview', asyncHandler(async (req, res) => {
  const [{ rows: clientCounts }, { rows: msgToday }, { rows: failedOnboardings }] = await Promise.all([
    pool.query(`select status, count(*)::int as count from clients group by status`),
    pool.query(`select coalesce(sum(messages_sent), 0)::int as sent, coalesce(sum(messages_received), 0)::int as received
                from usage_logs where date = current_date`),
    pool.query(`select count(*)::int as count from wabas where status = 'failed'`),
  ]);

  res.json({
    clientsByStatus: clientCounts,
    messagesToday: msgToday[0],
    failedOnboardings: failedOnboardings[0].count,
  });
}));

// --- Onboarding queue: anyone not yet fully active ---
router.get('/onboarding-queue', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    select c.id, c.name, c.email, c.status as client_status, c.created_at,
           s.status as subscription_status, s.plan,
           w.status as waba_status, w.quality_rating
    from clients c
    left join lateral (
      select * from subscriptions where client_id = c.id order by created_at desc limit 1
    ) s on true
    left join lateral (
      select * from wabas where client_id = c.id order by created_at desc limit 1
    ) w on true
    where c.status != 'active'
    order by c.created_at desc
  `);

  const withStuckStep = rows.map((r) => {
    let stuckAt = 'signup';
    if (r.client_status === 'pending_setup') stuckAt = 'awaiting_payment';
    else if (r.client_status === 'payment_confirmed' && (!r.waba_status || r.waba_status === 'failed')) stuckAt = 'awaiting_whatsapp_connection';
    else if (r.waba_status === 'connecting') stuckAt = 'whatsapp_connection_in_progress';
    return { ...r, stuck_at: stuckAt };
  });

  res.json(withStuckStep);
}));

// --- WABA health monitor across all tenants ---
router.get('/wabas', asyncHandler(async (req, res) => {
  const rows = await wabasRepo.listAllWithClient();
  res.json(rows.map(maskWaba));
}));

// --- Rich client detail: client + subscription + waba + templates + audit trail ---
router.get('/clients/:id', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const client = await clientsRepo.findById(pool, id);
  if (!client) return res.status(404).json({ error: 'Not found' });

  const [subscription, waba, templates, auditTrail] = await Promise.all([
    subscriptionsRepo.findByClientId(pool, id),
    wabasRepo.findByClientId(id),
    messageTemplatesRepo.listByClientId(pool, id),
    auditLogRepo.list({ clientId: id, limit: 50 }),
  ]);

  const { password_hash, ...safeClient } = client;

  res.json({ client: safeClient, subscription, waba: maskWaba(waba), templates, auditTrail });
}));

// --- Manual retry: re-pull phone number status from Meta for a connected WABA ---
router.post('/clients/:id/retry-provisioning', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const waba = await wabasRepo.findByClientId(id);
  if (!waba || !waba.access_token_encrypted) {
    return res.status(400).json({ error: 'No WhatsApp connection to retry — client must complete Embedded Signup first' });
  }

  try {
    const accessToken = decrypt(waba.access_token_encrypted);
    const details = await metaClient.getPhoneNumberDetails(waba.phone_number_id, accessToken);
    const updated = await wabasRepo.upsertForClient(id, {
      display_name: details.verified_name || waba.display_name,
      quality_rating: details.quality_rating || waba.quality_rating,
      status: 'connected',
    });
    await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: 'retry_provisioning', target: id });
    res.json({ retried: true, waba: maskWaba(updated) });
  } catch (err) {
    res.status(502).json({ error: 'Retry failed', detail: err.message });
  }
}));

// --- Meta data-deletion requests (spec §10 compliance) ---
router.get('/data-deletion-requests', asyncHandler(async (req, res) => {
  res.json(await dataDeletionRequestsRepo.listPending());
}));

router.post('/data-deletion-requests/:code/complete', asyncHandler(async (req, res) => {
  const request = await dataDeletionRequestsRepo.markCompleted(req.params.code);
  if (!request) return res.status(404).json({ error: 'Unknown confirmation code' });
  await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: 'data_deletion_completed', target: req.params.code });
  res.json(request);
}));

// --- Audit log ---
router.get('/audit-log', asyncHandler(async (req, res) => {
  const clientId = req.query.client_id ? z.string().uuid().parse(req.query.client_id) : undefined;
  res.json(await auditLogRepo.list({ clientId, limit: 200 }));
}));

// --- Admin team management ---
router.get('/admin-users', asyncHandler(async (req, res) => {
  res.json(await adminUsersRepo.list());
}));

router.post('/admin-users', asyncHandler(async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    role: z.enum(['super_admin', 'support', 'billing', 'platform_admin']),
  });
  const { name, email, password, role } = schema.parse(req.body);
  const password_hash = await hashPassword(password);
  const admin = await adminUsersRepo.create({ name, email, role, password_hash });
  // Creating an admin account grants durable, high-privilege access — this is
  // exactly the action that must be traceable after the fact (see migration
  // 021_audit_log_actor_ip.js's module comment for why actor_ip exists at all).
  await auditLogRepo.record({
    actor_type: 'admin',
    actor_id: req.adminId,
    action: 'admin_user_created',
    target: `${admin.id}: ${email} (${role})`,
    actor_ip: req.ip,
  });
  const loginUrl = `<a href="${process.env.APP_URL || 'http://localhost:3000'}/admin/index.html">${process.env.APP_URL || 'http://localhost:3000'}/admin</a>`;
  await sendEmail({
    to: email,
    subject: 'You’ve been added to Wasi CRM admin',
    html: `<p>${name}, you now have <strong>${role}</strong> access to the Wasi CRM admin panel.</p><p>Log in at ${loginUrl} with the email/password your admin gave you.</p>`,
  });
  res.status(201).json(admin);
}));

// --- Billing (spec §5 "Billing" row) ---
router.get('/billing/overview', asyncHandler(async (req, res) => {
  const [subscriptions, plans] = await Promise.all([subscriptionsRepo.listAllWithClient(pool), plansRepo.list()]);
  const priceByPlan = Object.fromEntries(plans.map((p) => [p.id, p.price_inr]));
  const active = subscriptions.filter((s) => s.status === 'active');
  const estimatedMrr = active.reduce((sum, s) => sum + (priceByPlan[s.plan] || 0), 0);
  const byPlan = active.reduce((acc, s) => {
    acc[s.plan] = (acc[s.plan] || 0) + 1;
    return acc;
  }, {});

  res.json({
    estimatedMrr,
    activeCount: active.length,
    failedOrPendingCount: subscriptions.length - active.length,
    byPlan,
    subscriptions,
  });
}));

// --- Templates Review (spec §5 "Templates Review" row) ---
const TEMPLATE_STATUSES = ['approved', 'pending', 'rejected', 'paused', 'disabled', 'pending_deletion', 'in_appeal'];

router.get('/templates', asyncHandler(async (req, res) => {
  const status = TEMPLATE_STATUSES.includes(req.query.status) ? req.query.status : null;
  res.json(await messageTemplatesRepo.listAll(pool, status));
}));

router.patch('/templates/:id', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { status } = templateStatusUpdateSchema.parse(req.body);
  const template = await messageTemplatesRepo.updateStatus(pool, id, status);
  if (!template) return res.status(404).json({ error: 'Not found' });
  await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: `template_${status}`, target: id });
  res.json(template);
}));

// --- Support / Tickets (spec §5 "Support / Tickets" row) ---
router.get('/tickets', asyncHandler(async (req, res) => {
  const status = ['open', 'in_progress', 'resolved', 'closed'].includes(req.query.status) ? req.query.status : null;
  res.json(await supportTicketsRepo.listAll(pool, status));
}));

router.patch('/tickets/:id', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { status } = ticketStatusUpdateSchema.parse(req.body);
  const ticket = await supportTicketsRepo.updateStatus(pool, id, status);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: `ticket_${status}`, target: id });
  res.json(ticket);
}));

// --- Hub API keys (build plan Phase 5) --- consuming apps (GV Mart, Sirah
// CRM, etc.) don't self-serve keys — issuing one is a Sirah-team action,
// same trust tier as creating an admin user above. Full list of keys across
// every tenant, since this is inherently a cross-tenant admin view (spec
// §6 "API keys — which app, which tenant, revoke").
router.get('/api-keys', asyncHandler(async (req, res) => {
  const clientId = req.query.client_id ? z.string().uuid().parse(req.query.client_id) : null;
  if (clientId) return res.json(await apiKeysRepo.listByClientId(pool, clientId));
  const { rows } = await pool.query(`
    select k.id, k.client_id, k.app_name, k.last_used_at, k.revoked_at, k.created_at, c.name as client_name
    from api_keys k join clients c on c.id = k.client_id
    where k.deleted_at is null
    order by k.created_at desc
  `);
  res.json(rows);
}));

// Raw key is returned exactly once, here — never retrievable again after
// this response, same "show once" rule as everything else that generates a
// secret in this codebase.
router.post('/api-keys', asyncHandler(async (req, res) => {
  const schema = z.object({ client_id: z.string().uuid(), app_name: z.string().min(1) });
  const { client_id, app_name } = schema.parse(req.body);
  const client = await clientsRepo.findById(pool, client_id);
  if (!client) return res.status(404).json({ error: 'Unknown client_id' });

  const { record, rawKey } = await apiKeysRepo.create(pool, client_id, app_name);
  await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: 'api_key_created', target: `${client_id}: ${app_name}` });
  // key_hash is internal (the lookup value requireApiKey.js hashes an
  // incoming bearer key against) — the intended secret to reveal here is
  // rawKey, given separately below; key_hash has no reason to ever leave
  // this process.
  const { key_hash, ...safeRecord } = record;
  res.status(201).json({ ...safeRecord, key: rawKey });
}));

// Bulk-issue a Hub API key for every client that doesn't already have an
// active one — the admin-panel button for onboarding the whole existing
// client base onto the CRM integration at once, not just new clients
// (the /api/clients auto-issue only covers clients created from here on).
// Idempotent by construction: a client with any non-revoked key is skipped,
// so clicking this twice (or after some clients already got one manually)
// never creates a second live key for someone who's already covered.
router.post('/api-keys/backfill', asyncHandler(async (req, res) => {
  const { rows: allClients } = await pool.query(`select id, name from clients order by created_at asc`);
  const { rows: withActiveKey } = await pool.query(`select distinct client_id from api_keys where revoked_at is null`);
  const haveKey = new Set(withActiveKey.map((r) => r.client_id));
  const missing = allClients.filter((c) => !haveKey.has(c.id));

  const issued = [];
  for (const client of missing) {
    const { record, rawKey } = await apiKeysRepo.create(pool, client.id, 'CRM Integration');
    await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: 'api_key_created', target: `${client.id}: ${record.app_name} (backfill)` });
    issued.push({ client_id: client.id, client_name: client.name, app_name: record.app_name, key: rawKey });
  }

  res.json({ issued, alreadyHadKey: allClients.length - missing.length });
}));

router.post('/api-keys/:id/revoke', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const schema = z.object({ client_id: z.string().uuid() });
  const { client_id } = schema.parse(req.body);
  const revoked = await apiKeysRepo.revoke(pool, id, client_id);
  if (!revoked) return res.status(404).json({ error: 'Not found, or already revoked' });
  await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: 'api_key_revoked', target: id });
  const { key_hash, ...safeRevoked } = revoked;
  res.json(safeRevoked);
}));

// Delete works on a key in any state — see apiKeysRepo.softDelete's comment.
// Soft tombstone, not a row delete, so it's a DELETE verb over an endpoint
// that never actually removes the row; that's intentional (see migration
// 034_api_key_soft_delete.js) — DELETE is still the correct HTTP semantics
// from the caller's point of view, since the key permanently leaves the list.
router.delete('/api-keys/:id', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const schema = z.object({ client_id: z.string().uuid() });
  const { client_id } = schema.parse(req.body);
  const deleted = await apiKeysRepo.softDelete(pool, id, client_id);
  if (!deleted) return res.status(404).json({ error: 'Not found, or already deleted' });
  await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: 'api_key_deleted', target: id });
  res.json({ ok: true });
}));

// --- Hub inbound forwarding config (build plan Phase 5) — sets
// wabas.forward_to_url/forward_events for a client's connected WABA. Was
// missing entirely until now: the columns existed (migration
// 014_hub_capability.js) and metaWebhook.js already read them, but nothing
// ever wrote them outside a test's direct repo call — this is the actual
// configuration point. Admin-provisioned, same trust tier as api-keys
// above, since a hub-connected consuming app is set up by Sirah's own
// team, not self-served. events is required (hubForwardConfigSchema),
// not defaulted — see migration 015_explicit_forward_events.js.
router.post('/clients/:id/hub-forward', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { forward_to_url, events } = hubForwardConfigSchema.parse(req.body);

  const existing = await wabasRepo.findByClientId(id);
  if (!existing) return res.status(404).json({ error: 'No WABA connected for this client yet' });

  const isNewSecret = !existing.forward_secret;
  const forward_secret = existing.forward_secret || crypto.randomBytes(24).toString('hex');
  const updated = await wabasRepo.upsertForClient(id, { forward_to_url, forward_secret, forward_events: events });
  await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: 'hub_forward_configured', target: id });
  // Only a genuinely new secret (first-time setup) is ever returned raw —
  // saving the URL/events on top of an existing secret must not re-expose it.
  res.json(isNewSecret ? { ...maskWaba(updated), forward_secret } : maskWaba(updated));
}));

// Separate, explicit action — force-generates a new forward_secret even if
// one already exists, invalidating the old one immediately (deliveries
// already queued keep using their snapshotted target_secret — see migration
// 014_hub_capability.js's comment — only future deliveries are affected).
// The frontend must warn before calling this.
router.post('/clients/:id/hub-forward/regenerate-secret', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const existing = await wabasRepo.findByClientId(id);
  if (!existing || !existing.forward_to_url) return res.status(404).json({ error: 'No hub forwarding configured for this client yet' });

  const forward_secret = crypto.randomBytes(24).toString('hex');
  const updated = await wabasRepo.upsertForClient(id, { forward_secret });
  await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: 'hub_forward_secret_regenerated', target: id });
  res.json({ ...maskWaba(updated), forward_secret });
}));

// --- Platform Overview: tenant, WABA, phone number, connection status, plan,
// connected date, in one row per client. Formerly the super-admin-only
// /api/super-admin/clients view — folded in here since there's now a single
// admin dashboard, not a separate cross-tenant one. Still queries via `pool`
// (not req.db) like the rest of this router; nothing about that changed. ---
router.get('/clients-overview', asyncHandler(async (req, res) => {
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

// --- Health per client: quality rating, restriction status, last successful
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

// --- Volume: sends per client per day ---
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

// --- Statistics/Analytics: trend data for the admin Statistics view.
// Read-only aggregation over tables that already exist (usage_logs, clients,
// webhook_deliveries, api_keys) — no new tables. `days` follows the same
// clamped rolling-window convention as /volume above, for consistency. ---
router.get('/stats', asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

  const [
    { rows: messageVolume },
    { rows: clientGrowth },
    { rows: webhookByStatus },
    { rows: webhookDaily },
    { rows: apiKeyTotals },
    { rows: apiKeyDaily },
    { rows: apiKeyActivity },
  ] = await Promise.all([
    pool.query(
      `select date, coalesce(sum(messages_sent), 0)::int as messages_sent,
              coalesce(sum(messages_received), 0)::int as messages_received
       from usage_logs where date >= current_date - $1::int
       group by date order by date asc`,
      [days]
    ),
    pool.query(
      `select date_trunc('day', created_at)::date as date, count(*)::int as new_clients
       from clients where created_at >= current_date - $1::int
       group by 1 order by 1 asc`,
      [days]
    ),
    pool.query(
      `select status, count(*)::int as count from webhook_deliveries
       where created_at >= current_date - $1::int
       group by status`,
      [days]
    ),
    pool.query(
      `select date_trunc('day', created_at)::date as date,
              count(*) filter (where status = 'delivered')::int as delivered,
              count(*) filter (where status = 'failed')::int as failed
       from webhook_deliveries where created_at >= current_date - $1::int
       group by 1 order by 1 asc`,
      [days]
    ),
    pool.query(
      `select count(*) filter (where revoked_at is null and deleted_at is null)::int as active,
              count(*) filter (where revoked_at is not null and deleted_at is null)::int as revoked,
              count(*) filter (where deleted_at is not null)::int as deleted
       from api_keys`
    ),
    pool.query(
      `select date_trunc('day', created_at)::date as date, count(*)::int as keys_issued
       from api_keys where created_at >= current_date - $1::int and deleted_at is null
       group by 1 order by 1 asc`,
      [days]
    ),
    // Most recently active keys, for a "which client/app is actually using
    // the Hub API" list that links into that client's detail page.
    pool.query(
      `select k.client_id, c.name as client_name, k.app_name, k.last_used_at
       from api_keys k join clients c on c.id = k.client_id
       where k.deleted_at is null and k.last_used_at is not null
       order by k.last_used_at desc limit 10`
    ),
  ]);

  res.json({
    days,
    messageVolume,
    clientGrowth,
    webhookDeliveries: { byStatus: webhookByStatus, daily: webhookDaily },
    apiKeys: { totals: apiKeyTotals[0], daily: apiKeyDaily, recentActivity: apiKeyActivity },
  });
}));

// --- Failures: failed sends with Meta error codes, webhook_deliveries in
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

// A flow that silently stopped is the same class of problem as a dropped
// webhook — visible here for the same reason failures/sends and
// failures/webhook-deliveries are: an operator shouldn't have to query the
// DB to find out automation broke for a client (flow_events'
// 'stalled' detail carries the actual MessagingError message/code, see
// flowEngine.js's runToRest).
router.get('/failures/stalled-flows', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    select cfs.id, cfs.client_id, c.name as client_name, ct.name as contact_name, ct.phone as contact_phone,
           af.name as flow_name, fn.type as node_type, cfs.updated_at, fe.detail as stall_detail
    from contact_flow_state cfs
    join clients c on c.id = cfs.client_id
    join contacts ct on ct.id = cfs.contact_id
    join automation_flows af on af.id = cfs.flow_id
    left join flow_nodes fn on fn.id = cfs.current_node_id
    left join lateral (
      select detail from flow_events
      where contact_id = cfs.contact_id and flow_id = cfs.flow_id and event_type = 'stalled'
      order by created_at desc
      limit 1
    ) fe on true
    where cfs.status = 'stalled'
    order by cfs.updated_at desc
    limit 200
  `);
  res.json(rows);
}));

// --- Settings (spec §5 "Settings" row) ---
// Read-only status, never the actual secret values — this is a platform
// config health check, not a way to edit secrets from a web form.
router.get('/settings', asyncHandler(async (req, res) => {
  const plans = await plansRepo.list();
  res.json({
    meta: {
      configured: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_CONFIG_ID),
      graphApiVersion: process.env.META_GRAPH_API_VERSION || null,
      webhookVerifyTokenSet: Boolean(process.env.META_WEBHOOK_VERIFY_TOKEN),
    },
    razorpay: {
      configured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      webhookSecretSet: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
    },
    secrets: {
      // Matches the actual placeholder text in .env.example
      // ("...-change-before-any-real-deploy") — a prior space-vs-hyphen
      // mismatch here meant this always reported "Rotated" even on a
      // freshly-cloned dev environment that never touched these values.
      jwtSecretIsDefault: /change-me|change.before/.test(process.env.JWT_SECRET || ''),
      serverSecretIsDefault: /change-me|change.before/.test(process.env.SERVER_SECRET || ''),
    },
    plans,
  });
}));

// Meta Official Template Library (wasi-master-plan.md §2b) — admin-facing
// refresh controls. GET /status is read-only (last refresh time, whether
// it errored, cached entry count); POST /refresh does the real Meta fetch
// synchronously and returns the result inline, same "await it, no queue"
// shape as every other admin-triggered action in this file — an admin
// clicking "Refresh Catalog" expects to see the outcome, not poll for it.
router.get('/template-library/meta/status', asyncHandler(async (req, res) => {
  const meta = await metaTemplateLibraryRepo.getRefreshMeta(pool);
  const cached = await metaTemplateLibraryRepo.listCached(pool, { includeParameterized: true });
  res.json({
    last_refreshed_at: meta?.last_refreshed_at || null,
    last_refresh_entry_count: meta?.last_refresh_entry_count ?? null,
    last_refresh_error: meta?.last_refresh_error || null,
    cached_total_count: cached.length,
    cached_zero_variable_count: cached.filter((e) => (e.body_params || []).length === 0).length,
  });
}));

router.post('/template-library/meta/refresh', asyncHandler(async (req, res) => {
  try {
    const count = await metaTemplateLibraryRefreshRunner.refreshNow();
    await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: 'meta_template_library_refreshed', target: `${count} entries` });
    res.json({ ok: true, entry_count: count });
  } catch (err) {
    res.status(502).json({ error: 'Refresh failed', detail: err.message });
  }
}));

module.exports = router;
