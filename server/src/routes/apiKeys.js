// Client self-serve Hub API key management — deliberately a policy reversal
// of admin.js's original "consuming apps don't self-serve keys" comment
// (build plan Phase 5). A client can now revoke/delete their OWN key(s)
// through this route, scoped by req.clientId (requireClientAuth), the same
// way every other /api/* resource route is tenant-scoped.
//
// POST / (build plan Phase 4, wasi-master-plan.md §3.1) — issuing a new key
// was previously admin-only/backfill-only. Added specifically so a client
// can generate their own named key (e.g. "Zapier") without contacting
// support, for the Zapier interim-auth flow (Phase 0 decision: no OAuth
// dependency, the client pastes this key straight into Zapier's own "API
// Key" connection field). Same generate-hash-persist-raw-key-once shape as
// admin.js's own POST /api-keys — this isn't a second implementation, it
// calls the same apiKeysRepo.create.
//
// Every OTHER mutation here is blocked from dropping a client to zero active
// keys (see wouldLeaveNoActiveKeys below): unlike the admin panel, a client
// had no self-serve way to reissue one before this route existed, so a
// self-inflicted lockout would leave their live integration dead with no
// recovery path except contacting support. That guard doesn't apply to
// creation itself, which only ever adds capacity.
const { Router } = require('express');
const apiKeysRepo = require('../repositories/apiKeysRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const zapierSubscriptionsRepo = require('../repositories/zapierSubscriptionsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, apiKeySelfCreateSchema } = require('../utils/validate');
const { apiKeyCreationLimiter } = require('../middleware/rateLimit');

const router = Router();

const LAST_KEY_ERROR = {
  error: 'This is your only active API key. Removing it would break your live integration with no way to self-recover, since issuing a new key is admin-only.',
  code: 'last_active_key',
  hint: 'To rotate safely: contact support to issue a second key first, confirm it works in your integration, then revoke/delete this one. To remove this key with no replacement, contact support directly.',
};

// Never returns key_hash — listByClientId's own column list already omits
// it (see apiKeysRepo.js), and the raw secret itself was only ever shown
// once, at admin-issuance time; it can't be recovered or displayed here.
router.get('/', asyncHandler(async (req, res) => {
  const keys = await apiKeysRepo.listByClientId(req.db, req.clientId);
  res.json(keys);
}));

// rawKey is shown exactly once, in this response — it can't be recovered
// later (only key_hash is ever stored, see apiKeysRepo.js's module comment).
// apiKeyCreationLimiter (10/hour per client): an independent audit found
// this was the one Hub-API-adjacent route with no abuse throttle at all —
// every /api/v1/* route has apiLimiter, auth has authLimiter, this route
// mints a live Bearer credential on every call and had nothing.
router.post('/', apiKeyCreationLimiter, asyncHandler(async (req, res) => {
  const { app_name } = apiKeySelfCreateSchema.parse(req.body);
  const { record, rawKey } = await apiKeysRepo.create(req.db, req.clientId, app_name);
  await auditLogRepo.record({ actor_type: 'client', actor_id: req.clientId, action: 'api_key_created', target: `${req.clientId}: ${app_name}` });
  const { key_hash, ...safeRecord } = record;
  res.status(201).json({ ...safeRecord, key: rawKey });
}));

// True only when removing `targetId` would leave the client with zero
// active (non-revoked) keys — i.e. the target itself is still active AND
// it's the only active one. A key that's already revoked can be soft-deleted
// freely regardless of how many other keys exist, since it isn't
// contributing any active capability to protect.
function wouldLeaveNoActiveKeys(keys, targetId) {
  const target = keys.find((k) => k.id === targetId);
  if (!target || target.revoked_at) return false;
  const activeCount = keys.filter((k) => !k.revoked_at).length;
  return activeCount <= 1;
}

router.post('/:id/revoke', asyncHandler(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const keys = await apiKeysRepo.listByClientId(req.db, req.clientId);
  const target = keys.find((k) => k.id === id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (target.revoked_at) return res.status(404).json({ error: 'Not found, or already revoked' });
  if (wouldLeaveNoActiveKeys(keys, id)) return res.status(409).json(LAST_KEY_ERROR);

  const revoked = await apiKeysRepo.revoke(req.db, id, req.clientId);
  // Independent audit finding: revoke/softDelete are tombstones (never a
  // real SQL DELETE), so migration 040's api_key_id ON DELETE CASCADE never
  // actually fires — a live Zapier subscription created with this key would
  // otherwise keep receiving events forever after "revoke," contradicting
  // this route's whole purpose. Explicit cleanup here closes that gap.
  await zapierSubscriptionsRepo.removeByApiKeyId(req.db, id);
  await auditLogRepo.record({ actor_type: 'client', actor_id: req.clientId, action: 'api_key_revoked', target: id });
  res.json(revoked);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const keys = await apiKeysRepo.listByClientId(req.db, req.clientId);
  const target = keys.find((k) => k.id === id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (wouldLeaveNoActiveKeys(keys, id)) return res.status(409).json(LAST_KEY_ERROR);

  const deleted = await apiKeysRepo.softDelete(req.db, id, req.clientId);
  if (!deleted) return res.status(404).json({ error: 'Not found, or already deleted' });
  // Same reasoning as the revoke handler above: softDelete never issues a
  // real SQL DELETE, so migration 040's ON DELETE CASCADE never fires here
  // either — a deleted key's Zapier subscription needs explicit cleanup too.
  await zapierSubscriptionsRepo.removeByApiKeyId(req.db, id);
  await auditLogRepo.record({ actor_type: 'client', actor_id: req.clientId, action: 'api_key_deleted', target: id });
  res.json({ ok: true });
}));

module.exports = router;
