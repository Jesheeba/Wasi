const { Router } = require('express');
const broadcastsRepo = require('../repositories/broadcastsRepo');
const broadcastRecipientsRepo = require('../repositories/broadcastRecipientsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { broadcastCreateSchema } = require('../utils/validate');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await broadcastsRepo.list(req.clientId));
}));

router.post('/', asyncHandler(async (req, res) => {
  const { templateName, ...data } = broadcastCreateSchema.parse(req.body);
  const broadcast = await broadcastsRepo.create(req.clientId, { ...data, template_name: templateName });
  const recipients = await broadcastRecipientsRepo.createFromAudience(broadcast.id, req.clientId, data.tag_id);
  if (recipients.length === 0) {
    await broadcastsRepo.markStatus(broadcast.id, 'Completed');
  }
  // broadcastRunner.js (started in index.js) picks up 'Sending' broadcasts'
  // pending recipients on its next tick — no synchronous send here, so this
  // returns immediately even for a large audience.
  res.status(201).json({ ...broadcast, recipient_count: recipients.length });
}));

module.exports = router;
