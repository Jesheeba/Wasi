const { Router } = require('express');
const adminUsersRepo = require('../repositories/adminUsersRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { comparePassword, signSuperAdminToken } = require('../utils/auth');
const { loginSchema } = require('../utils/validate');
const { requireSuperAdminAuth } = require('../middleware/requireSuperAdminAuth');

const router = Router();

// Forgot/reset-password deliberately reuse /api/admin/auth's existing routes
// rather than duplicating them — adminAuth.js's forgot-password/reset-password
// don't filter by role, so they already work for a platform_admin row.

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const admin = await adminUsersRepo.findByEmail(email);
  if (!admin || admin.role !== 'platform_admin') {
    // Same message whether the email doesn't exist or exists with the wrong
    // role — a support/billing admin trying this route shouldn't learn
    // that their account merely lacks super-admin access.
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await comparePassword(password, admin.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  const token = signSuperAdminToken(admin);
  res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } });
}));

router.get('/me', requireSuperAdminAuth(), asyncHandler(async (req, res) => {
  const admin = await adminUsersRepo.findById(req.superAdminId);
  if (!admin) return res.status(404).json({ error: 'Not found' });
  res.json(admin);
}));

module.exports = router;
