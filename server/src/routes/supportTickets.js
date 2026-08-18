const { Router } = require('express');
const supportTicketsRepo = require('../repositories/supportTicketsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { supportTicketCreateSchema } = require('../utils/validate');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await supportTicketsRepo.listByClientId(req.db, req.clientId));
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = supportTicketCreateSchema.parse(req.body);
  const ticket = await supportTicketsRepo.create(req.db, req.clientId, data);
  res.status(201).json(ticket);
}));

module.exports = router;
