const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { authLimiter, webhookLimiter, apiLimiter } = require('./middleware/rateLimit');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { apiV1NotFoundHandler, apiV1ErrorHandler } = require('./middleware/apiV1ErrorHandler');
const { requireClientAuth } = require('./middleware/requireClientAuth');
const { requireAdminAuth } = require('./middleware/requireAdminAuth');
const { withTenantContext } = require('./middleware/tenantContext');

const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const adminAuthRouter = require('./routes/adminAuth');
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
const broadcastsRouter = require('./routes/broadcasts');
const automationRulesRouter = require('./routes/automationRules');
const automationFlowsRouter = require('./routes/automationFlows');
const templatesRouter = require('./routes/templates');
const supportTicketsRouter = require('./routes/supportTickets');
const analyticsRouter = require('./routes/analytics');
const teamMembersRouter = require('./routes/teamMembers');
const contactAttributesRouter = require('./routes/contactAttributes');
const paymentLinksRouter = require('./routes/paymentLinks');
const walletRouter = require('./routes/wallet');
const clientWebhookRouter = require('./routes/clientWebhook');
const apiKeysRouter = require('./routes/apiKeys');
const templateLibraryRouter = require('./routes/templateLibrary');
const contactListsRouter = require('./routes/contactLists');
const apiV1MessagesRouter = require('./routes/apiV1Messages');
const apiV1TemplatesRouter = require('./routes/apiV1Templates');
const apiV1ConversationsRouter = require('./routes/apiV1Conversations');
const apiV1ContactsRouter = require('./routes/apiV1Contacts');
const apiV1AccountRouter = require('./routes/apiV1Account');
const apiV1SubscriptionsRouter = require('./routes/apiV1Subscriptions');

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
  // Cherry-picked from the unmerged origin/gap-fixes-a-e branch (see
  // CLAUDE.md Known Gaps for why only this piece, not the rest of that
  // branch, was brought in). CSP left off deliberately: the root/admin/
  // marketing static pages (no build step) rely on inline scripts/styles,
  // and a default CSP would break them without a real audit of every
  // inline block first — a separate, riskier follow-up. Every other helmet
  // default (HSTS, X-Content-Type-Options, X-Frame-Options, X-Powered-By
  // removal, etc.) is safe to enable immediately.
  app.use(helmet({ contentSecurityPolicy: false }));
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
  app.use('/api/contact-lists', requireClientAuth, withTenantContext, contactListsRouter);
  app.use('/api/automation-rules', requireClientAuth, withTenantContext, automationRulesRouter);
  app.use('/api/automation-flows', requireClientAuth, withTenantContext, automationFlowsRouter);
  app.use('/api/templates', requireClientAuth, withTenantContext, templatesRouter);
  app.use('/api/support-tickets', requireClientAuth, withTenantContext, supportTicketsRouter);
  app.use('/api/analytics', requireClientAuth, withTenantContext, analyticsRouter);
  app.use('/api/team-members', requireClientAuth, withTenantContext, teamMembersRouter);
  app.use('/api/contact-attributes', requireClientAuth, withTenantContext, contactAttributesRouter);
  app.use('/api/payment-links', requireClientAuth, withTenantContext, paymentLinksRouter);
  app.use('/api/wallet', requireClientAuth, withTenantContext, walletRouter);
  app.use('/api/client-webhook', requireClientAuth, withTenantContext, clientWebhookRouter);
  app.use('/api/api-keys', requireClientAuth, withTenantContext, apiKeysRouter);
  app.use('/api/template-library', requireClientAuth, withTenantContext, templateLibraryRouter);

  // Meta calls these directly (no client JWT available).
  app.use('/webhooks/meta/data-deletion', webhookLimiter, metaDataDeletionRouter);
  app.use('/webhooks/meta', webhookLimiter, metaWebhookRouter);
  app.use('/webhooks/razorpay', webhookLimiter, razorpayWebhookRouter);

  // Admin-only: internal team, gated by admin JWT.
  app.use('/api/clients', requireAdminAuth(), clientsRouter);
  app.use('/api/admin', requireAdminAuth(), adminRouter);

  // Hub API (build plan Phase 5): other Sirah applications, authenticated by
  // a Wasi-issued API key (requireApiKey), not a client JWT — always the
  // privileged connection, see middleware/requireApiKey.js.
  app.use('/api/v1/messages', apiLimiter, apiV1MessagesRouter);
  app.use('/api/v1/templates', apiLimiter, apiV1TemplatesRouter);
  app.use('/api/v1/conversations', apiLimiter, apiV1ConversationsRouter);
  app.use('/api/v1/contacts', apiLimiter, apiV1ContactsRouter);
  app.use('/api/v1/account', apiLimiter, apiV1AccountRouter);
  // Zapier REST Hook subscribe/unsubscribe (build plan Phase 4) — same Hub
  // API shape as the five routers above, not a client-facing resource.
  app.use('/api/v1/subscriptions', apiLimiter, apiV1SubscriptionsRouter);
  // Catches unmatched /api/v1/* paths and any error thrown inside the six
  // routers above (Zod validation, Postgres constraint violations, an
  // uncaught error) — both in the {error: {code, message}} shape, before
  // falling through to the app-wide handlers below, which stay on the old
  // {error: 'string'} shape for every other route in this app.
  app.use('/api/v1', apiV1NotFoundHandler);
  app.use('/api/v1', apiV1ErrorHandler);

  // Static frontends (no build step) — mounted explicitly by directory
  // rather than serving the whole repo root, so server/.env, node_modules,
  // etc. are never reachable over HTTP even by path-guessing.
  app.get('/', (req, res) => res.sendFile(path.join(REPO_ROOT, 'index.html')));
  app.get('/index.html', (req, res) => res.sendFile(path.join(REPO_ROOT, 'index.html')));
  app.get('/index.css', (req, res) => res.sendFile(path.join(REPO_ROOT, 'index.css')));
  app.get('/breakpoints.css', (req, res) => res.sendFile(path.join(REPO_ROOT, 'breakpoints.css')));
  app.get('/app.js', (req, res) => res.sendFile(path.join(REPO_ROOT, 'app.js')));
  app.get('/embeddedSignup.js', (req, res) => res.sendFile(path.join(REPO_ROOT, 'embeddedSignup.js')));
  app.use('/marketing', express.static(path.join(REPO_ROOT, 'marketing')));
  app.use('/admin', express.static(path.join(REPO_ROOT, 'admin')));
  // Postman collection + environment template for the admin panel's API
  // Guide view to link to directly — static files, no auth needed (no
  // secrets in them, placeholders only; see postman/README.md).
  app.use('/postman', express.static(path.join(REPO_ROOT, 'postman')));
  // Stage 1 spike (flow-editor/) — the one build-step exception in this
  // repo, served from its own path exactly like marketing/admin above, not
  // injected into index.html/app.js's existing load path. Built by the
  // Dockerfile's separate flow-editor-build stage; this directory won't
  // exist until that runs (`npm run build` inside flow-editor/), so it's
  // absent in a plain `git clone` — expected, not a bug.
  app.use('/flow-editor', express.static(path.join(REPO_ROOT, 'flow-editor/dist')));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
