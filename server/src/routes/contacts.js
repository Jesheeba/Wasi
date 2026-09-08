const { Router } = require('express');
const contactsRepo = require('../repositories/contactsRepo');
const consentRepo = require('../repositories/consentRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, contactCreateSchema, contactUpdateSchema, consentEventCreateSchema } = require('../utils/validate');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await contactsRepo.list(req.db, req.clientId));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const contact = await contactsRepo.findById(req.db, req.clientId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.json(contact);
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = contactCreateSchema.parse(req.body);
  const contact = await contactsRepo.create(req.db, req.clientId, data);
  res.status(201).json(contact);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = contactUpdateSchema.parse(req.body);
  const contact = await contactsRepo.update(req.db, req.clientId, req.params.id, data);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.json(contact);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const deleted = await contactsRepo.remove(req.db, req.clientId, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

// The only route that can change opt_in_status — deliberately not part of
// the generic PATCH above (see validate.js's consentEventCreateSchema
// comment). Requires a source; writes an immutable consent_events row in
// the same transaction as the status change. consentRepo.recordEvent runs
// on its own privileged connection (see its module comment), not req.db.
router.post('/:id/consent', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = consentEventCreateSchema.parse(req.body);
  const contact = await consentRepo.recordEvent(req.clientId, req.params.id, data);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.status(201).json(contact);
}));

router.get('/:id/consent', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const contact = await contactsRepo.findById(req.db, req.clientId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.json(await consentRepo.listEventsForContact(req.db, req.clientId, req.params.id));
}));

module.exports = router;
