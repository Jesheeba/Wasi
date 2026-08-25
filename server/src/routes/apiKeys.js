// Client-authenticated self-service for Hub API keys (GAP_FIX_PLAN.md Phase
// C2). Admin-created clients already get one auto-generated at creation
// time (routes/clients.js, POST /api/clients) and can get more/revoke via
// the admin panel's API Keys page (routes/admin.js) — this is the
// equivalent surface for a client who signed themselves up through
// /marketing/signup.html (POST /api/auth/register), who has no admin in
// the loop to hand a key to them.
//
// Reuses apiKeysRepo.js as-is (the same create/list/revoke functions
// routes/admin.js and routes/clients.js already call) — no new key
// generation/hashing logic. Runs on req.db/req.clientId like every other
// tenant-scoped route (see routes/tags.js) — api_keys already has RLS
// enabled and forced with a tenant_isolation policy (migration
// 014_hub_capability.js), which until now had no real caller going through
// the restricted wasi_app role to exercise it; this route is that caller.
const { Router } = require('express');
const apiKeysRepo = require('../repositories/apiKeysRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { apiKeyCreateSchema, uuid } = require('../utils/validate');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await apiKeysRepo.listByClientId(req.db, req.clientId));
}));

// Raw key returned exactly once, here — never retrievable again, same
// "show once" rule as the admin-panel equivalent and every other
// secret-generating endpoint in this codebase.
router.post('/', asyncHandler(async (req, res) => {
  const { app_name } = apiKeyCreateSchema.parse(req.body);
  const { record, rawKey } = await apiKeysRepo.create(req.db, req.clientId, app_name);
  await auditLogRepo.record({
    actor_type: 'client',
    actor_id: req.clientId,
    action: 'api_key_created',
    target: app_name,
  });
  res.status(201).json({ ...record, key: rawKey });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const revoked = await apiKeysRepo.revoke(req.db, id, req.clientId);
  if (!revoked) return res.status(404).json({ error: 'Not found, or already revoked' });
  await auditLogRepo.record({
    actor_type: 'client',
    actor_id: req.clientId,
    action: 'api_key_revoked',
    target: id,
  });
  res.json(revoked);
}));

module.exports = router;
