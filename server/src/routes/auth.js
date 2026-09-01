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

  const token = signClientToken(client);
  const { password_hash: _omit, ...safeClient } = client;
  res.json({ token, client: safeClient });
}));

router.get('/me', sessionCheckLimiter, requireClientAuth, withTenantContext, asyncHandler(async (req, res) => {
  const client = await clientsRepo.findById(req.db, req.clientId);
  if (!client) return res.status(404).json({ error: 'Not found' });
  res.json(client);
}));

// Always 200 regardless of whether the email exists — a differing response
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
  res.json({ message: 'Password updated — you can log in now.' });
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

module.exports = router;
