const { Router } = require('express');
const { pool } = require('../db/pool');
const clientsRepo = require('../repositories/clientsRepo');
const authTokensRepo = require('../repositories/authTokensRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { hashPassword, comparePassword, signClientToken } = require('../utils/auth');
const { slugify } = require('../utils/slug');
const { sendEmail } = require('../utils/emailService');
const { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } = require('../utils/validate');
const { requireClientAuth } = require('../middleware/requireClientAuth');
const { withTenantContext } = require('../middleware/tenantContext');
const { authLimiter, sessionCheckLimiter } = require('../middleware/rateLimit');
const { z } = require('zod');
const { verifyGoogleIdToken, GoogleTokenError } = require('../utils/googleIdToken');

const router = Router();

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  const { businessName, email, password } = registerSchema.parse(req.body);

  const existing = await clientsRepo.findByEmail(pool, email);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const baseSlug = slugify(businessName) || 'client';
  let tenant_slug = baseSlug;
  let suffix = 1;
  while (await clientsRepo.slugExists(pool, tenant_slug)) {
    tenant_slug = `${baseSlug}-${suffix++}`;
  }

  const password_hash = await hashPassword(password);
  const client = await clientsRepo.create(pool, {
    name: businessName,
    email,
    tenant_slug,
    status: 'pending_setup',
    password_hash,
  });

  const token = await authTokensRepo.create('client', client.id, 'email_verification', 60 * 24);
  await sendEmail({
    to: email,
    subject: 'Verify your Wasi CRM account',
    html: `<p>Welcome to Wasi CRM! Verify your email:</p><p><a href="${APP_URL}/marketing/verify-email.html?token=${token}">Verify email</a></p>`,
  });

  const signedToken = signClientToken(client);
  const { password_hash: _omit, ...safeClient } = client;
  res.status(201).json({ token: signedToken, client: safeClient });
}));

router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const client = await clientsRepo.findByEmail(pool, email);
  if (!client || !client.password_hash) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await comparePassword(password, client.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  await clientsRepo.touchLastLogin(pool, client.id);
  const token = signClientToken(client);
  const { password_hash: _omit, ...safeClient } = client;
  res.json({ token, client: safeClient });
}));

router.get('/me', sessionCheckLimiter, requireClientAuth, withTenantContext, asyncHandler(async (req, res) => {
  const client = await clientsRepo.findById(req.db, req.clientId);
  if (!client) return res.status(404).json({ error: 'Not found' });
  res.json(client);
}));

// Always 200 regardless of whether the email exists - a differing response
// would let an attacker enumerate registered accounts.
router.post('/forgot-password', authLimiter, asyncHandler(async (req, res) => {
  const { email } = forgotPasswordSchema.parse(req.body);
  const client = await clientsRepo.findByEmail(pool, email);
  if (client) {
    const token = await authTokensRepo.create('client', client.id, 'password_reset', 60);
    await sendEmail({
      to: email,
      subject: 'Reset your Wasi CRM password',
      html: `<p>Reset your password (link expires in 1 hour):</p><p><a href="${APP_URL}/marketing/reset-password.html?token=${token}">Reset password</a></p>`,
    });
  }
  res.json({ message: 'If that email is registered, a reset link has been sent.' });
}));

router.post('/reset-password', authLimiter, asyncHandler(async (req, res) => {
  const { token, password } = resetPasswordSchema.parse(req.body);
  const consumed = await authTokensRepo.consume(token, 'password_reset');
  if (!consumed || consumed.subject_type !== 'client') {
    return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  }
  const password_hash = await hashPassword(password);
  await clientsRepo.update(pool, consumed.subject_id, { password_hash });
  await clientsRepo.bumpTokenVersion(pool, consumed.subject_id);
  res.json({ message: 'Password updated - you can log in now.' });
}));

router.post('/verify-email/request', sessionCheckLimiter, requireClientAuth, withTenantContext, asyncHandler(async (req, res) => {
  const client = await clientsRepo.findById(req.db, req.clientId);
  if (!client) return res.status(404).json({ error: 'Not found' });
  if (client.email_verified) return res.json({ message: 'Already verified.' });

  const token = await authTokensRepo.create('client', client.id, 'email_verification', 60 * 24);
  await sendEmail({
    to: client.email,
    subject: 'Verify your Wasi CRM account',
    html: `<p>Verify your email:</p><p><a href="${APP_URL}/marketing/verify-email.html?token=${token}">Verify email</a></p>`,
  });
  res.json({ message: 'Verification email sent.' });
}));

router.post('/verify-email', authLimiter, asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });
  const consumed = await authTokensRepo.consume(token, 'email_verification');
  if (!consumed || consumed.subject_type !== 'client') {
    return res.status(400).json({ error: 'This verification link is invalid or has expired.' });
  }
  await clientsRepo.update(pool, consumed.subject_id, { email_verified: true });
  res.json({ message: 'Email verified.' });
}));

// ---- "Continue with Google" (build-docs/features/google-login.md) ----------
// The browser gets a Google ID token from Google Identity Services and posts
// it here. Only the public client id is involved; there is no client secret.
//
// Account matching, in order:
//   1. a client already linked to this Google account (google_sub)
//   2. a client with the same email (case-insensitive): Google has verified
//      the email, so it is linked and signed in
//   3. otherwise, intent 'signup' creates a new client (business name
//      required); intent 'login' never creates one silently.
router.get('/google/config', (req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || null });
});

const googleAuthSchema = z.object({
  credential: z.string().min(20).max(4096),
  intent: z.enum(['signup', 'login']),
  businessName: z.string().trim().min(1).max(120).optional(),
}).strict();

router.post('/google', authLimiter, asyncHandler(async (req, res) => {
  const { credential, intent, businessName } = googleAuthSchema.parse(req.body);
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google sign-in is not set up yet.' });

  let google;
  try {
    google = await verifyGoogleIdToken(credential);
  } catch (err) {
    if (err instanceof GoogleTokenError) {
      return res.status(401).json({ error: 'Google sign-in could not be verified. Please try again.' });
    }
    throw err;
  }

  let client = (await pool.query('select * from clients where google_sub = $1', [google.sub])).rows[0];
  if (!client) {
    client = (await pool.query('select * from clients where lower(email) = lower($1) order by created_at limit 1', [google.email])).rows[0];
    if (client) {
      if (client.google_sub && client.google_sub !== google.sub) {
        return res.status(409).json({ error: 'This email is already linked to a different Google account.' });
      }
      await pool.query('update clients set google_sub = $2, email_verified = true where id = $1', [client.id, google.sub]);
    }
  }

  if (client) {
    await clientsRepo.touchLastLogin(pool, client.id);
    return res.json({ token: signClientToken(client), client: await clientsRepo.findById(pool, client.id), created: false });
  }

  if (intent !== 'signup') {
    return res.status(404).json({ error: 'No Wasi account uses this Google account yet. Create one first.', code: 'no_account' });
  }
  if (!businessName) {
    return res.status(400).json({ error: 'Enter your business name first.', code: 'business_name_required' });
  }

  const baseSlug = slugify(businessName) || 'client';
  let tenant_slug = baseSlug;
  let suffix = 1;
  while (await clientsRepo.slugExists(pool, tenant_slug)) tenant_slug = `${baseSlug}-${suffix++}`;

  // No password: a Google-only account can add one later via "Forgot password".
  const created = await clientsRepo.create(pool, {
    name: businessName, email: google.email, tenant_slug, status: 'pending_setup', password_hash: null,
  });
  await pool.query('update clients set google_sub = $2, email_verified = true where id = $1', [created.id, google.sub]);
  await clientsRepo.touchLastLogin(pool, created.id);
  res.status(201).json({ token: signClientToken(created), client: await clientsRepo.findById(pool, created.id), created: true });
}));

module.exports = router;
