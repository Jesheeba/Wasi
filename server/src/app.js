const express = require('express');
const cors = require('cors');
const path = require('path');
const { authLimiter, webhookLimiter, apiLimiter } = require('./middleware/rateLimit');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { requireClientAuth } = require('./middleware/requireClientAuth');
const { requireAdminAuth } = require('./middleware/requireAdminAuth');
const { requireSuperAdminAuth } = require('./middleware/requireSuperAdminAuth');
const { withTenantContext } = require('./middleware/tenantContext');

const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const adminAuthRouter = require('./routes/adminAuth');
const superAdminAuthRouter = require('./routes/superAdminAuth');
const clientsRouter = require('./routes/clients');
const contactsRouter = require('./routes/contacts');
const chatsRouter = require('./routes/chats');
const tagsRouter = require('./routes/tags');
const onboardingRouter = require('./routes/onboarding');
const metaWebhookRouter = require('./routes/metaWebhook');
const metaDataDeletionRouter = require('./routes/metaDataDeletion');
const billingRouter = require('./routes/billing');
const razorpayWebhookRouter = require('./routes/razorpayWebhook');
const adminRouter = require('./routes/admin');
const superAdminRouter = require('./routes/superAdmin');
const broadcastsRouter = require('./routes/broadcasts');
const automationRulesRouter = require('./routes/automationRules');
const templatesRouter = require('./routes/templates');
const supportTicketsRouter = require('./routes/supportTickets');
const analyticsRouter = require('./routes/analytics');
const teamMembersRouter = require('./routes/teamMembers');
const contactAttributesRouter = require('./routes/contactAttributes');
const paymentLinksRouter = require('./routes/paymentLinks');
const walletRouter = require('./routes/wallet');
const clientWebhookRouter = require('./routes/clientWebhook');
const apiV1MessagesRouter = require('./routes/apiV1Messages');
const apiV1TemplatesRouter = require('./routes/apiV1Templates');

// Same-origin static pages (this app.js, admin/, marketing/) never send an
// Origin header Express sees as cross-site, so this allowlist only matters
// for the split-origin local dev setup (`npm start` on :3000 hitting :4000)
// and any future separately-hosted frontend. No entry here = browser fetches
// from that origin are rejected; server-to-server calls (Meta/Razorpay
// webhooks, curl) have no Origin header and are always allowed through.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const REPO_ROOT = path.join(__dirname, '..', '..');

function createApp() {
  const app = express();
  // Without this, express-rate-limit's default keyGenerator (req.ip) resolves
  // to the immediate socket peer — the proxy in front of us (ngrok locally,
  // Render's load balancer in production) — not the real client, so every
  // distinct caller shares one rate-limit bucket instead of getting their
  // own. `1` trusts exactly one hop of X-Forwarded-For, matching both of
  // those single-proxy setups.
  app.set('trust proxy', 1);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));
  // Captures raw bytes alongside the parsed body — needed to verify the
  // Razorpay and Meta webhook signatures, which are computed over the exact
  // raw payload.
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  // Meta's data deletion callback posts as a URL-encoded form field
  // (`signed_request`), not JSON.
  app.use(express.urlencoded({ extended: false }));

  app.use('/health', healthRouter);

  app.use('/api/auth', authLimiter, authRouter);
  app.use('/api/admin/auth', authLimiter, adminAuthRouter);
  app.use('/api/super-admin/auth', authLimiter, superAdminAuthRouter);

  // Tenant-scoped: real client JWT required. withTenantContext runs every
  // request inside its own transaction as the restricted `wasi_app` role
  // with app.current_client_id set (migration 013_tenant_isolation.js) —
  // RLS is the actual enforcement, this just makes the connection subject
  // to it.
  app.use('/api/contacts', requireClientAuth, withTenantContext, contactsRouter);
  app.use('/api/chats', requireClientAuth, withTenantContext, chatsRouter);
  app.use('/api/tags', requireClientAuth, withTenantContext, tagsRouter);
  app.use('/api/onboarding', requireClientAuth, withTenantContext, onboardingRouter);
  app.use('/api/billing', requireClientAuth, withTenantContext, billingRouter);
  app.use('/api/broadcasts', requireClientAuth, withTenantContext, broadcastsRouter);
  app.use('/api/automation-rules', requireClientAuth, withTenantContext, automationRulesRouter);
  app.use('/api/templates', requireClientAuth, withTenantContext, templatesRouter);
  app.use('/api/support-tickets', requireClientAuth, withTenantContext, supportTicketsRouter);
  app.use('/api/analytics', requireClientAuth, withTenantContext, analyticsRouter);
  app.use('/api/team-members', requireClientAuth, withTenantContext, teamMembersRouter);
  app.use('/api/contact-attributes', requireClientAuth, withTenantContext, contactAttributesRouter);
  app.use('/api/payment-links', requireClientAuth, withTenantContext, paymentLinksRouter);
  app.use('/api/wallet', requireClientAuth, withTenantContext, walletRouter);
  app.use('/api/client-webhook', requireClientAuth, withTenantContext, clientWebhookRouter);

  // Meta calls these directly (no client JWT available).
  app.use('/webhooks/meta/data-deletion', webhookLimiter, metaDataDeletionRouter);
  app.use('/webhooks/meta', webhookLimiter, metaWebhookRouter);
  app.use('/webhooks/razorpay', webhookLimiter, razorpayWebhookRouter);

  // Admin-only: internal team, gated by admin JWT + role.
  app.use('/api/clients', requireAdminAuth(['super_admin', 'support']), clientsRouter);
  app.use('/api/admin', requireAdminAuth(), adminRouter);
  app.use('/api/super-admin', requireSuperAdminAuth(), superAdminRouter);

  // Hub API (build plan Phase 5): other Sirah applications, authenticated by
  // a Wasi-issued API key (requireApiKey), not a client JWT — always the
  // privileged connection, see middleware/requireApiKey.js.
  app.use('/api/v1/messages', apiLimiter, apiV1MessagesRouter);
  app.use('/api/v1/templates', apiLimiter, apiV1TemplatesRouter);

  // Static frontends (no build step) — mounted explicitly by directory
  // rather than serving the whole repo root, so server/.env, node_modules,
  // etc. are never reachable over HTTP even by path-guessing.
  app.get('/', (req, res) => res.sendFile(path.join(REPO_ROOT, 'index.html')));
  app.get('/index.html', (req, res) => res.sendFile(path.join(REPO_ROOT, 'index.html')));
  app.get('/index.css', (req, res) => res.sendFile(path.join(REPO_ROOT, 'index.css')));
  app.get('/app.js', (req, res) => res.sendFile(path.join(REPO_ROOT, 'app.js')));
  app.get('/embeddedSignup.js', (req, res) => res.sendFile(path.join(REPO_ROOT, 'embeddedSignup.js')));
  app.use('/marketing', express.static(path.join(REPO_ROOT, 'marketing')));
  app.use('/admin', express.static(path.join(REPO_ROOT, 'admin')));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
