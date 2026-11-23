// PLAN.md item 15 - Meta conversation pricing / cost calculator, admin CRUD
// side. Mounted under /api/admin with its own requireAdminAuth() (app.js),
// same as clientsRouter - not a client-facing write surface. See
// routes/analytics.js's GET /cost-estimate for the client-facing read side.
const { Router } = require('express');
const conversationPricingRepo = require('../repositories/conversationPricingRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { conversationPricingUpsertSchema } = require('../utils/validate');
const { requireAdminRole } = require('../middleware/requireAdminAuth');

const router = Router();

// Role policy, same decision as routes/admin.js: setting what Wasi charges
// per conversation is billing policy, not support/operational work - only
// billing/super_admin/platform_admin may write a rate. Reads stay open to
// any admin role (useful context for support without a write risk).
const billingOrFull = requireAdminRole('super_admin', 'platform_admin', 'billing');

router.get('/', asyncHandler(async (req, res) => {
  res.json(await conversationPricingRepo.list());
}));

// Upsert by (category, country_code) - re-submitting an existing pair
// updates its rate in place rather than erroring, matching this codebase's
// established "re-entering = updating" precedent.
router.post('/', billingOrFull, asyncHandler(async (req, res) => {
  const { category, countryCode, rateInr } = conversationPricingUpsertSchema.parse(req.body);
  const row = await conversationPricingRepo.upsert({ category, countryCode, rateInr });
  res.status(201).json(row);
}));

router.delete('/:id', billingOrFull, asyncHandler(async (req, res) => {
  const removed = await conversationPricingRepo.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Rate not found' });
  res.status(204).end();
}));

module.exports = router;
