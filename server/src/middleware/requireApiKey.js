// Authenticates server-to-server hub API calls (build plan Phase 5) — GV
// Mart, Sirah CRM, RD Interlocks, Fortune Innovatives authenticate with a
// Wasi-issued API key, never a Meta token.
//
// Always runs on the privileged `pool` connection, like admin.js and
// metaWebhook.js, never req.db/withTenantContext — documented decision, not
// an oversight, for two independent reasons: (1) this is exactly the same
// "resolve identity from an opaque credential before any client_id is known"
// shape as wabasRepo.findByWabaId and clientsRepo.findByEmail — there's no
// client_id to set app.current_client_id to until the key has already been
// looked up, so the restricted role's RLS policy has nothing to key off of
// yet; (2) these are first-party, trusted server-to-server callers (Sirah's
// own other applications), the same trust tier as the admin panel, not
// arbitrary tenant-authenticated browser traffic.
const { pool } = require('../db/pool');
const apiKeysRepo = require('../repositories/apiKeysRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const logger = require('../utils/logger');

const requireApiKey = asyncHandler(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer API key' });
  }

  const record = await apiKeysRepo.findActiveByHash(pool, token);
  if (!record) {
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }

  req.clientId = record.client_id;
  req.apiKeyId = record.id;
  // Not awaited: last_used_at is a diagnostic, not part of the auth
  // decision — a slow or failed update must never delay or fail the
  // request it's attached to.
  apiKeysRepo.touchLastUsed(pool, record.id).catch((err) => {
    logger.error({ err, apiKeyId: record.id }, 'apiKeysRepo: touchLastUsed failed (non-fatal)');
  });

  next();
});

module.exports = { requireApiKey };
