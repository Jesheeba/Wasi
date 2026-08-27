// Client self-serve Hub API key management — deliberately a policy reversal
// of admin.js's original "consuming apps don't self-serve keys" comment
// (build plan Phase 5). A client can now revoke/delete their OWN key(s)
// through this route, scoped by req.clientId (requireClientAuth), the same
// way every other /api/* resource route is tenant-scoped. Issuing a NEW key
// stays admin-only/backfill-only, unchanged — this file has no POST /.
//
// Every mutation here is blocked from dropping a client to zero active keys
// (see wouldLeaveNoActiveKeys below): unlike the admin panel, a client has no
// self-serve way to reissue one, so a self-inflicted lockout would leave
// their live integration dead with no recovery path except contacting
// support. The admin panel intentionally keeps no such guard — an admin can
// always issue a replacement in the same visit.
const { Router } = require('express');
const apiKeysRepo = require('../repositories/apiKeysRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid } = require('../utils/validate');

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
  await auditLogRepo.record({ actor_type: 'client', actor_id: req.clientId, action: 'api_key_deleted', target: id });
  res.json({ ok: true });
}));

module.exports = router;
