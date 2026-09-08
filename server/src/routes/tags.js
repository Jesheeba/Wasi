const { Router } = require('express');
const tagsRepo = require('../repositories/tagsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { tagCreateSchema } = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');

const router = Router();

router.get('/', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  res.json(await tagsRepo.list(req.db, req.clientId));
}));

router.post('/', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  const data = tagCreateSchema.parse(req.body);
  const tag = await tagsRepo.create(req.db, req.clientId, data);
  res.status(201).json(tag);
}));

module.exports = router;
