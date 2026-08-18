const { Router } = require('express');
const broadcastsRepo = require('../repositories/broadcastsRepo');
const broadcastRecipientsRepo = require('../repositories/broadcastRecipientsRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { broadcastCreateSchema } = require('../utils/validate');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await broadcastsRepo.list(req.db, req.clientId));
}));

router.post('/', asyncHandler(async (req, res) => {
  const { templateName, ...data } = broadcastCreateSchema.parse(req.body);
  const broadcast = await broadcastsRepo.create(req.db, req.clientId, { ...data, template_name: templateName });
  const recipients = await broadcastRecipientsRepo.createFromAudience(req.db, broadcast.id, req.clientId, data.tag_id);
  if (recipients.length === 0) {
    await broadcastsRepo.markStatus(req.db, broadcast.id, 'Completed');
  }

  // Consent warning (build plan Phase 4) — computed here, before
  // broadcastRunner's next tick actually attempts anything (it skips
  // non-opted-in recipients rather than sending to them, same rule as
  // messagingService.assertConsentForTemplate: unrecognized category fails
  // closed, treated as marketing).
  const template = await messageTemplatesRepo.findByNameAndClient(req.db, req.clientId, templateName);
  const requiresConsent = !template || template.category === 'Marketing';
  let consentWarning = null;
  if (requiresConsent && recipients.length > 0) {
    const optedInCount = recipients.filter((r) => r.opt_in_status === 'opted_in').length;
    const notOptedInCount = recipients.length - optedInCount;
    if (notOptedInCount > recipients.length / 2) {
      consentWarning = `${notOptedInCount} of ${recipients.length} recipients have not opted in to marketing messages and will be skipped, not sent.`;
    }
  }

  // broadcastRunner.js (started in index.js) picks up 'Sending' broadcasts'
  // pending recipients on its next tick — no synchronous send here, so this
  // returns immediately even for a large audience.
  res.status(201).json({ ...broadcast, recipient_count: recipients.length, consentWarning });
}));

module.exports = router;
