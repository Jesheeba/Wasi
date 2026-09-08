const { Router } = require('express');
const cannedResponsesRepo = require('../repositories/cannedResponsesRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, cannedResponseCreateSchema } = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');

const router = Router();

router.get('/', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  res.json(await cannedResponsesRepo.list(req.db, req.clientId));
}));

router.post('/', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  const data = cannedResponseCreateSchema.parse(req.body);
  const created = await cannedResponsesRepo.create(req.db, req.clientId, data);
  res.status(201).json(created);
}));

router.delete('/:id', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const deleted = await cannedResponsesRepo.remove(req.db, req.clientId, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

module.exports = router;
