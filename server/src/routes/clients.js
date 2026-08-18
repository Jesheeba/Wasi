const { Router } = require('express');
const { pool } = require('../db/pool');
const clientsRepo = require('../repositories/clientsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, clientCreateSchema, clientUpdateSchema } = require('../utils/validate');

const router = Router();

// clientsRepo.findById/create/update already exclude password_hash from
// what they select/return (see clientsRepo.js) — this is now a no-op
// safety net, not the only guard.
const omitPasswordHash = ({ password_hash, ...safe }) => safe;

router.get('/', asyncHandler(async (req, res) => {
  res.json((await clientsRepo.list(pool)).map(omitPasswordHash));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const client = await clientsRepo.findById(pool, req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  res.json(omitPasswordHash(client));
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = clientCreateSchema.parse(req.body);
  const client = await clientsRepo.create(pool, data);
  res.status(201).json(omitPasswordHash(client));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = clientUpdateSchema.parse(req.body);
  const client = await clientsRepo.update(pool, req.params.id, data);
  if (!client) return res.status(404).json({ error: 'Not found' });
  res.json(omitPasswordHash(client));
}));

// NOTE: deletes cascade to every tenant table for this client (contacts, chats,
// messages, everything). Fine for a dev scaffold — a real admin panel needs a
// soft-delete/confirmation gate before this ships.
router.delete('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const deleted = await clientsRepo.remove(pool, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

module.exports = router;
