const { Router } = require('express');
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
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');
const { hashPassword } = require('../utils/auth');
const { sendEmail } = require('../utils/emailService');
const { asyncHandler } = require('../utils/asyncHandler');
const { templateStatusUpdateSchema, ticketStatusUpdateSchema } = require('../utils/validate');
const { z } = require('zod');

const router = Router();

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
  res.json(rows.map(({ access_token_encrypted, ...rest }) => rest));
}));

// --- Rich client detail: client + subscription + waba + templates + audit trail ---
router.get('/clients/:id', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const client = await clientsRepo.findById(id);
  if (!client) return res.status(404).json({ error: 'Not found' });

  const [subscription, waba, templates, auditTrail] = await Promise.all([
    subscriptionsRepo.findByClientId(id),
    wabasRepo.findByClientId(id),
    messageTemplatesRepo.listByClientId(id),
    auditLogRepo.list({ clientId: id, limit: 50 }),
  ]);

  const { password_hash, ...safeClient } = client;
  const safeWaba = waba ? (({ access_token_encrypted, ...rest }) => rest)(waba) : null;

  res.json({ client: safeClient, subscription, waba: safeWaba, templates, auditTrail });
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
    const { access_token_encrypted, ...safe } = updated;
    res.json({ retried: true, waba: safe });
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

// --- Admin team management (super_admin only) ---
router.get('/admin-users', asyncHandler(async (req, res) => {
  res.json(await adminUsersRepo.list());
}));

router.post('/admin-users', asyncHandler(async (req, res) => {
  if (req.adminRole !== 'super_admin') return res.status(403).json({ error: 'Only super_admin can create admin users' });
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    role: z.enum(['super_admin', 'support', 'billing']),
  });
  const { name, email, password, role } = schema.parse(req.body);
  const password_hash = await hashPassword(password);
  const admin = await adminUsersRepo.create({ name, email, role, password_hash });
  await sendEmail({
    to: email,
    subject: 'You’ve been added to Wasi CRM admin',
    html: `<p>${name}, you now have <strong>${role}</strong> access to the Wasi CRM admin panel.</p><p>Log in at <a href="${process.env.APP_URL || 'http://localhost:3000'}/admin/index.html">${process.env.APP_URL || 'http://localhost:3000'}/admin</a> with the email/password your admin gave you.</p>`,
  });
  res.status(201).json(admin);
}));

// --- Billing (spec §5 "Billing" row) ---
router.get('/billing/overview', asyncHandler(async (req, res) => {
  const [subscriptions, plans] = await Promise.all([subscriptionsRepo.listAllWithClient(), plansRepo.list()]);
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
router.get('/templates', asyncHandler(async (req, res) => {
  const status = ['approved', 'pending', 'rejected'].includes(req.query.status) ? req.query.status : null;
  res.json(await messageTemplatesRepo.listAll(status));
}));

router.patch('/templates/:id', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { status } = templateStatusUpdateSchema.parse(req.body);
  const template = await messageTemplatesRepo.updateStatus(id, status);
  if (!template) return res.status(404).json({ error: 'Not found' });
  await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: `template_${status}`, target: id });
  res.json(template);
}));

// --- Support / Tickets (spec §5 "Support / Tickets" row) ---
router.get('/tickets', asyncHandler(async (req, res) => {
  const status = ['open', 'in_progress', 'resolved', 'closed'].includes(req.query.status) ? req.query.status : null;
  res.json(await supportTicketsRepo.listAll(status));
}));

router.patch('/tickets/:id', asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { status } = ticketStatusUpdateSchema.parse(req.body);
  const ticket = await supportTicketsRepo.updateStatus(id, status);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: `ticket_${status}`, target: id });
  res.json(ticket);
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

module.exports = router;
