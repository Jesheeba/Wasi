const { Router } = require('express');
const contactAttributesRepo = require('../repositories/contactAttributesRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, contactAttributeCreateSchema } = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');

const router = Router();

router.get('/', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  res.json(await contactAttributesRepo.list(req.db, req.clientId));
}));

router.post('/', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  const data = contactAttributeCreateSchema.parse(req.body);
  res.status(201).json(await contactAttributesRepo.create(req.db, req.clientId, data));
}));

router.delete('/:id', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const deleted = await contactAttributesRepo.remove(req.db, req.clientId, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

module.exports = router;
