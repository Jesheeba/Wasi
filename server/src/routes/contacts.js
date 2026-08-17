const { Router } = require('express');
const contactsRepo = require('../repositories/contactsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, contactCreateSchema, contactUpdateSchema } = require('../utils/validate');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await contactsRepo.list(req.clientId));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const contact = await contactsRepo.findById(req.clientId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.json(contact);
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = contactCreateSchema.parse(req.body);
  const contact = await contactsRepo.create(req.clientId, data);
  res.status(201).json(contact);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = contactUpdateSchema.parse(req.body);
  const contact = await contactsRepo.update(req.clientId, req.params.id, data);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.json(contact);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const deleted = await contactsRepo.remove(req.clientId, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

module.exports = router;
