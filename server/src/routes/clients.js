const crypto = require('crypto');
const { Router } = require('express');
const { z } = require('zod');
const { pool } = require('../db/pool');
const clientsRepo = require('../repositories/clientsRepo');
const apiKeysRepo = require('../repositories/apiKeysRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
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
    contact_person_name: data.contact_person_name,
    contact_phone: data.contact_phone,
    company_details: data.company_details,
    developer_name: data.developer_name,
    developer_phone: data.developer_phone,
    developer_email: data.developer_email,
    integration_requirements: data.integration_requirements,
    additional_notes: data.additional_notes,
  });

  // Every client gets a Hub API key (build plan Phase 5) at creation time,
  // not as a separate manual step — so their CRM/dev team can integrate
  // (POST /api/v1/messages, /api/v1/templates) from day one. Same
  // "generate, hash, persist only the hash, return raw key once" contract
  // as the manual /api/admin/api-keys route; see apiKeysRepo.js.
  const { record: apiKeyRecord, rawKey: apiKey } = await apiKeysRepo.create(pool, client.id, 'CRM Integration');
  await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: 'api_key_created', target: `${client.id}: ${apiKeyRecord.app_name} (auto, on client creation)` });

  res.status(201).json({
    ...omitPasswordHash(client),
    temporaryPassword,
    loginUrl: `${APP_URL}/index.html`,
    apiKey,
  });
}));

// Admin-triggered reset for an EXISTING client (e.g. they're locked out and
// have no working forgot-password email flow available). Same contract as
// creation's temporary password: generated here, hashed before it touches
// clientsRepo.update, returned in plaintext exactly once in this response,
// never stored or logged anywhere. Deliberately its own route rather than a
// field on PATCH — clientUpdateSchema has no password_hash column to set
// (see validate.js) and this should never be reachable by silently including
// a password in an otherwise-unrelated update.
router.post('/:id/reset-password', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const existing = await clientsRepo.findById(pool, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const temporaryPassword = generatePassword();
  const password_hash = await hashPassword(temporaryPassword);
  const client = await clientsRepo.update(pool, req.params.id, { password_hash });

  await auditLogRepo.record({ actor_type: 'admin', actor_id: req.adminId, action: 'client_password_reset', target: `${client.id}: ${client.email}` });

  res.json({ ...omitPasswordHash(client), temporaryPassword, loginUrl: `${APP_URL}/index.html` });
}));

// Real, previously-existing gap: this route never wrote an audit_log entry
// at all — the only automatic clients.status transition anywhere in this
// codebase (razorpayWebhook.js's pending_setup -> payment_confirmed) is
// logged, but every MANUAL admin status change (including suspend/
// reactivate — the "Service" toggle in admin) was silently untracked.
// Fixed alongside this feature since it directly matters here: an admin
// flipping Service off/on is exactly the kind of action that needs a paper
// trail (see this feature's own visible-not-just-reachable requirement for
// pending suspensions).
router.patch('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = clientUpdateSchema.parse(req.body);
  const existing = await clientsRepo.findById(pool, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  // activated_at is set exactly once, the moment status genuinely
  // transitions TO 'active' — this is the "date they started using the
  // application" the payment reminder's monthly cycle anchors to
  // (paymentReminderRunner.js). Never overwritten on a later active-again
  // transition (e.g. reactivated after a suspension) — the original
  // activation date stays the billing-cycle anchor, not a reset one.
  const fields = { ...data };
  if (data.status === 'active' && existing.status !== 'active' && !existing.activated_at) {
    fields.activated_at = new Date().toISOString();
  }
  // A manual status change always supersedes whatever the auto-suspend
  // mechanism was tracking — an admin explicitly setting status here (to
  // ANY value, not just back to active) means this client is no longer in
  // the auto-suspend flow's territory, so it shouldn't later auto-reactivate
  // them based on a stale flag.
  if (data.status) {
    fields.auto_suspended_for_nonpayment = false;
  }

  const client = await clientsRepo.update(pool, req.params.id, fields);
  if (!client) return res.status(404).json({ error: 'Not found' });

  if (data.status && data.status !== existing.status) {
    await auditLogRepo.record({
      actor_type: 'admin', actor_id: req.adminId,
      action: 'client_status_changed',
      target: `${client.id}: ${existing.status} -> ${data.status}`,
    });
  }

  res.json(omitPasswordHash(client));
}));

// The "Paid"/"Unpaid" toggle (admin UI) — separate from the generic status
// PATCH above since it has its own side effects beyond a raw column set
// (starting/clearing the nonpayment countdown, and auto-reactivating
// Service if THIS mechanism, not an unrelated manual suspension, was what
// suspended it — see auto_suspended_for_nonpayment's own comment above and
// in migration 068).
router.post('/:id/payment-status', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const paid = z.boolean().parse(req.body.paid);
  const existing = await clientsRepo.findById(pool, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const fields = paid
    ? { payment_status: 'paid', payment_marked_unpaid_at: null, payment_warning_sent_at: null }
    : { payment_status: 'unpaid', payment_marked_unpaid_at: new Date().toISOString(), payment_warning_sent_at: null };

  // Marking paid restores Service automatically, but ONLY if THIS feature
  // was what suspended it — an admin who suspended a client for an
  // unrelated reason (abuse, a support dispute, anything else) shouldn't
  // have that decision silently undone by a payment status flip.
  if (paid && existing.auto_suspended_for_nonpayment) {
    fields.status = 'active';
    fields.auto_suspended_for_nonpayment = false;
  }

  const client = await clientsRepo.update(pool, req.params.id, fields);

  await auditLogRepo.record({
    actor_type: 'admin', actor_id: req.adminId,
    action: paid ? 'client_marked_paid' : 'client_marked_unpaid',
    target: `${client.id}: ${client.name}`,
  });

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
