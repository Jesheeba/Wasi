const crypto = require('crypto');
const { Router } = require('express');
const { pool } = require('../db/pool');
const clientsRepo = require('../repositories/clientsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, clientCreateSchema, clientUpdateSchema } = require('../utils/validate');
const { hashPassword } = require('../utils/auth');
const { slugify } = require('../utils/slug');

const router = Router();

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// clientsRepo.findById/create/update already exclude password_hash from
// what they select/return (see clientsRepo.js) — this is now a no-op
// safety net, not the only guard.
const omitPasswordHash = ({ password_hash, ...safe }) => safe;

// Base64 rather than hex so a 12-char result carries more entropy per
// character; strip the punctuation base64 can introduce so it stays easy
// to read/type back if handed over verbally.
function generatePassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
}

router.get('/', asyncHandler(async (req, res) => {
  res.json((await clientsRepo.list(pool)).map(omitPasswordHash));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const client = await clientsRepo.findById(pool, req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  res.json(omitPasswordHash(client));
}));

// Admin-created client. Unlike self-signup (routes/auth.js's /register), an
// admin only supplies name/email — no tenant_slug (auto-derived from name,
// same collision-suffix loop /register uses) and no password is required
// (auto-generated if omitted). The plaintext password is returned exactly
// once in this response, never stored or logged, so the admin can hand it
// to the client immediately.
router.post('/', asyncHandler(async (req, res) => {
  const data = clientCreateSchema.parse(req.body);

  const existing = await clientsRepo.findByEmail(pool, data.email);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  let tenant_slug = data.tenant_slug;
  if (!tenant_slug) {
    const baseSlug = slugify(data.name) || 'client';
    tenant_slug = baseSlug;
    let suffix = 1;
    while (await clientsRepo.slugExists(pool, tenant_slug)) {
      tenant_slug = `${baseSlug}-${suffix++}`;
    }
  }

  const temporaryPassword = data.password || generatePassword();
  const password_hash = await hashPassword(temporaryPassword);

  const client = await clientsRepo.create(pool, {
    name: data.name,
    email: data.email,
    tenant_slug,
    status: data.status,
    password_hash,
  });

  res.status(201).json({
    ...omitPasswordHash(client),
    temporaryPassword,
    loginUrl: `${APP_URL}/index.html`,
  });
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
