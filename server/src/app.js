const express = require('express');
const cors = require('cors');
const path = require('path');
const { authLimiter, webhookLimiter } = require('./middleware/rateLimit');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { requireClientAuth } = require('./middleware/requireClientAuth');
const { requireAdminAuth } = require('./middleware/requireAdminAuth');

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
const templatesRouter = require('./routes/templates');
const supportTicketsRouter = require('./routes/supportTickets');
const analyticsRouter = require('./routes/analytics');
const teamMembersRouter = require('./routes/teamMembers');
const contactAttributesRouter = require('./routes/contactAttributes');
const paymentLinksRouter = require('./routes/paymentLinks');
const walletRouter = require('./routes/wallet');
const clientWebhookRouter = require('./routes/clientWebhook');

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

  // Tenant-scoped: real client JWT required.
  app.use('/api/contacts', requireClientAuth, contactsRouter);
  app.use('/api/chats', requireClientAuth, chatsRouter);
  app.use('/api/tags', requireClientAuth, tagsRouter);
  app.use('/api/onboarding', requireClientAuth, onboardingRouter);
  app.use('/api/billing', requireClientAuth, billingRouter);
  app.use('/api/broadcasts', requireClientAuth, broadcastsRouter);
  app.use('/api/automation-rules', requireClientAuth, automationRulesRouter);
  app.use('/api/templates', requireClientAuth, templatesRouter);
  app.use('/api/support-tickets', requireClientAuth, supportTicketsRouter);
  app.use('/api/analytics', requireClientAuth, analyticsRouter);
  app.use('/api/team-members', requireClientAuth, teamMembersRouter);
  app.use('/api/contact-attributes', requireClientAuth, contactAttributesRouter);
  app.use('/api/payment-links', requireClientAuth, paymentLinksRouter);
  app.use('/api/wallet', requireClientAuth, walletRouter);
  app.use('/api/client-webhook', requireClientAuth, clientWebhookRouter);

  // Meta calls these directly (no client JWT available).
  app.use('/webhooks/meta/data-deletion', webhookLimiter, metaDataDeletionRouter);
  app.use('/webhooks/meta', webhookLimiter, metaWebhookRouter);
  app.use('/webhooks/razorpay', webhookLimiter, razorpayWebhookRouter);

  // Admin-only: internal team, gated by admin JWT + role.
  app.use('/api/clients', requireAdminAuth(['super_admin', 'support']), clientsRouter);
  app.use('/api/admin', requireAdminAuth(), adminRouter);

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
