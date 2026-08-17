const { Router } = require('express');
const adminUsersRepo = require('../repositories/adminUsersRepo');
const authTokensRepo = require('../repositories/authTokensRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { hashPassword, comparePassword, signAdminToken } = require('../utils/auth');
const { sendEmail } = require('../utils/emailService');
const { loginSchema, forgotPasswordSchema, resetPasswordSchema } = require('../utils/validate');
const { requireAdminAuth } = require('../middleware/requireAdminAuth');

const router = Router();

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const admin = await adminUsersRepo.findByEmail(email);
  if (!admin) return res.status(401).json({ error: 'Invalid email or password' });

  const valid = await comparePassword(password, admin.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  const token = signAdminToken(admin);
  res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } });
}));

router.get('/me', requireAdminAuth(), asyncHandler(async (req, res) => {
  const admin = await adminUsersRepo.findById(req.adminId);
  if (!admin) return res.status(404).json({ error: 'Not found' });
  res.json(admin);
}));

// Same enumeration-safe pattern as the client flow in routes/auth.js.
router.post('/forgot-password', asyncHandler(async (req, res) => {
  const { email } = forgotPasswordSchema.parse(req.body);
  const admin = await adminUsersRepo.findByEmail(email);
  if (admin) {
    const token = await authTokensRepo.create('admin', admin.id, 'password_reset', 60);
    await sendEmail({
      to: email,
      subject: 'Reset your Wasi CRM admin password',
      html: `<p>Reset your admin password (link expires in 1 hour):</p><p><a href="${APP_URL}/marketing/reset-password.html?token=${token}&admin=1">Reset password</a></p>`,
    });
  }
  res.json({ message: 'If that email is registered, a reset link has been sent.' });
}));

router.post('/reset-password', asyncHandler(async (req, res) => {
  const { token, password } = resetPasswordSchema.parse(req.body);
  const consumed = await authTokensRepo.consume(token, 'password_reset');
  if (!consumed || consumed.subject_type !== 'admin') {
    return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  }
  const password_hash = await hashPassword(password);
  await adminUsersRepo.updatePassword(consumed.subject_id, password_hash);
  res.json({ message: 'Password updated — you can log in now.' });
}));

module.exports = router;
