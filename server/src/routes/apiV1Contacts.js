// Hub API read endpoint (build plan Phase 5's MCP tool inventory) -
// search_contacts. Same requireApiKey + privileged `pool` shape as the rest
// of the Hub API (see apiV1Messages.js's module comment).
//
// `phone` is an exact match (contactsRepo.findByPhone already exists and is
// the fast/precise path); `q` is a substring match over name/phone done in
// JS after contactsRepo.list, since there's no existing ILIKE-based repo
// query to reuse and adding one is more backend surface than a v1 search
// tool needs. Same pagination reasoning as apiV1Conversations.js.
const { Router } = require('express');
const { pool } = require('../db/pool');
const { z } = require('zod');
const contactsRepo = require('../repositories/contactsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireApiKey } = require('../middleware/requireApiKey');
const consentRepo = require('../repositories/consentRepo');
const { recordHubApiConsent } = require('../services/hubApiConsent');
const { apiContactConsentSchema } = require('../utils/validate');
const { sendApiError } = require('../utils/apiError');

const router = Router();
router.use(requireApiKey);

const searchQuerySchema = z.object({
  q: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

router.get('/', asyncHandler(async (req, res) => {
  const { q, phone, limit } = searchQuerySchema.parse(req.query);

  if (phone) {
    const contact = await contactsRepo.findByPhone(pool, req.clientId, phone);
    return res.json(contact ? [contact] : []);
  }

  let contacts = await contactsRepo.list(pool, req.clientId);
  if (q) {
    const needle = q.toLowerCase();
    contacts = contacts.filter(
      (c) => (c.name || '').toLowerCase().includes(needle) || (c.phone || '').includes(needle)
    );
  }
  res.json(contacts.slice(0, limit));
}));

// Record a contact's marketing opt-in or opt-out collected outside Wasi
// (build-docs/features/marketing-consent-attestation.md). Creates the
// contact if the phone is new, same as a send does. Opt-out is sticky: an
// opt-in for a contact who opted out is refused, never applied.
router.post('/consent', asyncHandler(async (req, res) => {
  const data = apiContactConsentSchema.parse(req.body);
  const contact = await contactsRepo.upsertByPhone(pool, req.clientId, { phone: data.phone });
  try {
    const updated = await recordHubApiConsent(req.clientId, contact.id, {
      status: data.status, method: data.method, note: data.note, apiKeyId: req.apiKeyId,
    });
    if (!updated) return sendApiError(res, 404, 'contact_not_found', 'Contact not found.');
    res.json({
      id: updated.id, phone: updated.phone, opt_in_status: updated.opt_in_status,
      opt_in_at: updated.opt_in_at, opt_out_at: updated.opt_out_at,
    });
  } catch (err) {
    if (err instanceof consentRepo.ConsentBlockedError) {
      return sendApiError(res, 409, 'contact_opted_out', 'This contact has opted out of marketing messages - only the contact can undo that (e.g. by replying START).');
    }
    throw err;
  }
}));

module.exports = router;
