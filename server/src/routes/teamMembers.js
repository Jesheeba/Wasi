const { Router } = require('express');
const teamMembersRepo = require('../repositories/teamMembersRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, teamMemberCreateSchema } = require('../utils/validate');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await teamMembersRepo.list(req.clientId));
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = teamMemberCreateSchema.parse(req.body);
  res.status(201).json(await teamMembersRepo.create(req.clientId, data));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const deleted = await teamMembersRepo.remove(req.clientId, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

module.exports = router;
