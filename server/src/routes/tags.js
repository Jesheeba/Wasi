const { Router } = require('express');
const tagsRepo = require('../repositories/tagsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { tagCreateSchema } = require('../utils/validate');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await tagsRepo.list(req.clientId));
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = tagCreateSchema.parse(req.body);
  const tag = await tagsRepo.create(req.clientId, data);
  res.status(201).json(tag);
}));

module.exports = router;
