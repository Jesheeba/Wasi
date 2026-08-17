const { Router } = require('express');
const crypto = require('crypto');
const auditLogRepo = require('../repositories/auditLogRepo');
const dataDeletionRequestsRepo = require('../repositories/dataDeletionRequestsRepo');
const { asyncHandler } = require('../utils/asyncHandler');

const router = Router();

function base64UrlDecode(input) {
  return Buffer.from(String(input).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Parses + verifies Meta's signed_request format: base64url(HMAC-SHA256
// signature).base64url(JSON payload), signed with the app secret. Used for
// the data deletion callback (and, historically, deauthorize callbacks).
function parseSignedRequest(signedRequest, appSecret) {
  const [encodedSig, encodedPayload] = String(signedRequest || '').split('.');
  if (!encodedSig || !encodedPayload) return null;

  const expectedSig = crypto.createHmac('sha256', appSecret).update(encodedPayload).digest();
  const actualSig = base64UrlDecode(encodedSig);
  if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
    return null;
  }

  return JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
}

// Meta requires this endpoint for any app that touches user data (spec §10).
// When a user requests their Facebook data be deleted, Meta POSTs a signed
// payload here; we must respond with a status URL + confirmation code the
// user can check back on. We don't track individual Facebook user IDs
// against clients (WABAs are tied to businesses, not personal FB accounts),
// so this logs the request for manual follow-up rather than auto-deleting.
router.post('/', asyncHandler(async (req, res) => {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    return res.status(503).json({ error: 'META_APP_SECRET not configured' });
  }

  const payload = parseSignedRequest(req.body?.signed_request, appSecret);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid signed_request' });
  }

  const confirmationCode = crypto.randomBytes(8).toString('hex');
  await dataDeletionRequestsRepo.create(confirmationCode, payload.user_id);
  await auditLogRepo.record({
    actor_type: 'meta_data_deletion_request',
    actor_id: null,
    action: 'data_deletion_requested',
    target: `fb_user:${payload.user_id}, confirmation:${confirmationCode}`,
  });

  res.json({
    // Matches this router's own /status/:code route below (mounted at
    // /webhooks/meta/data-deletion) — must be an exact match or the link we
    // hand back to Meta/the user 404s.
    url: `${req.protocol}://${req.get('host')}/webhooks/meta/data-deletion/status/${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
}));

// The URL above must actually resolve — this is what a user (or Meta,
// checking on the user's behalf) lands on to see whether their deletion
// request was handled. Public by design, same as the callback itself.
router.get('/status/:code', asyncHandler(async (req, res) => {
  const request = await dataDeletionRequestsRepo.findByCode(req.params.code);
  if (!request) return res.status(404).json({ error: 'Unknown confirmation code' });
  res.json({ confirmation_code: request.confirmation_code, status: request.status, requested_at: request.requested_at, completed_at: request.completed_at });
}));

module.exports = router;
