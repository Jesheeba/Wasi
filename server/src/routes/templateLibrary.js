// WhatsApp Template Message Library (wasi-master-plan.md §2) — browse/
// filter the curated library and log "Use this Template" activity. No
// submission logic here at all: prefill happens entirely client-side
// (root app.js copies a library entry's fields into the existing
// Create-Template modal state) and the actual submission still goes
// through routes/templates.js's POST / unchanged — this route never talks
// to Meta and never writes to message_templates.
const { Router } = require('express');
const { z } = require('zod');
const templateLibraryRepo = require('../repositories/templateLibraryRepo');
const metaTemplateLibraryRepo = require('../repositories/metaTemplateLibraryRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const wabasRepo = require('../repositories/wabasRepo');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid } = require('../utils/validate');

const router = Router();

const listQuerySchema = z.object({
  industry: z.string().min(1).optional(),
  category: z.enum(['Marketing', 'Utility', 'Authentication']).optional(),
  use_case: z.string().min(1).optional(),
});

router.get('/', asyncHandler(async (req, res) => {
  const { industry, category, use_case: useCase } = listQuerySchema.parse(req.query);
  const entries = await templateLibraryRepo.listActive(req.db, { industry, category, useCase });
  res.json(entries);
}));

// Usage logging must never fail the client's actual "Use this Template"
// action — a lost analytics row is fine, a broken prefill isn't — so it's
// awaited (req.db is a single shared transactional connection per request;
// see tenantContext.js — a real fire-and-forget call here would just queue
// behind the response's own COMMIT anyway, with none of the usual
// non-blocking benefit, only more room for a future edit to reorder it
// into an actual race) and caught locally rather than left to fail the
// whole request.
router.post('/:id/use', asyncHandler(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const entry = await templateLibraryRepo.findActiveById(req.db, id);
  if (!entry) return res.status(404).json({ error: 'Not found' });

  try {
    await templateLibraryRepo.recordUsage(req.db, { libraryTemplateId: id, clientId: req.clientId });
  } catch (err) {
    console.error('templateLibraryRepo: recordUsage failed (non-fatal):', err.message);
  }

  res.json(entry);
}));

// --- Meta Official Template Library (wasi-master-plan.md §2b) ---
// Distinct source from the routes above: Meta's OWN pre-approved catalog,
// read-only, never editable. listCached defaults to zero-variable entries
// only (Phase 0 decision — see migration 042's comment); this route never
// widens that, matching what the client-facing UI is built to show.
router.get('/meta', asyncHandler(async (req, res) => {
  const entries = await metaTemplateLibraryRepo.listCached(req.db);
  res.json(entries);
}));

// Independent audit finding: base_url/phone_number were both .optional()
// regardless of type, so a client could submit { type: 'URL' } with no
// base_url and it would forward to Meta unvalidated. superRefine requires
// the field that actually matches the declared type.
const libraryButtonInputSchema = z.object({
  type: z.enum(['URL', 'PHONE_NUMBER']),
  base_url: z.string().url().optional(),
  phone_number: z.string().min(1).optional(),
}).superRefine((val, ctx) => {
  if (val.type === 'URL' && !val.base_url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'base_url is required for a URL button input.' });
  }
  if (val.type === 'PHONE_NUMBER' && !val.phone_number) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'phone_number is required for a PHONE_NUMBER button input.' });
  }
});

const useMetaLibraryTemplateSchema = z.object({
  name: z.string().min(1).max(512),
  // Keyed by array order, matching the entry's own buttons_json order — the
  // narrow modal (Phase 0 decision) only ever collects a destination per
  // button, never lets a client retype Meta's fixed button label/type.
  buttonInputs: z.array(libraryButtonInputSchema).optional(),
});

// Independent QA/Auditor finding: nothing checked buttonInputs' count/order/
// type against the entry's own buttons_json before forwarding to Meta — a
// client could submit 3 PHONE_NUMBER inputs against a zero-button entry and
// it would reach Meta unvalidated (this app's own defense-in-depth gap, not
// a security hole — Meta's API is still the real backstop, but every other
// part of this flow re-validates server-side rather than trusting the
// client). Only URL/PHONE_NUMBER buttons need an input (matches
// app.js's openUseMetaLibraryTemplateModal, which only renders inputs for
// those two types) — QUICK_REPLY etc. have no destination to override.
function validateButtonInputsMatchEntry(entry, buttonInputs) {
  const editableButtons = (entry.buttons_json || []).filter((b) => b.type === 'URL' || b.type === 'PHONE_NUMBER');
  const inputs = buttonInputs || [];
  if (inputs.length !== editableButtons.length) {
    return `This template has ${editableButtons.length} button destination(s) to fill in, but ${inputs.length} were submitted.`;
  }
  for (let i = 0; i < editableButtons.length; i++) {
    if (inputs[i].type !== editableButtons[i].type) {
      return `Button ${i + 1} must be type ${editableButtons[i].type}, not ${inputs[i].type}.`;
    }
  }
  return null;
}

// Submits a template FROM Meta's library — genuinely different from the
// POST /:id/use above (Wasi's own curated library): that one only logs
// usage and hands prefill data back to the client for the existing,
// freely-editable Create Template modal; this one calls Meta directly
// (metaClient.createTemplateFromLibrary, the same POST /{waba-id}/
// message_templates endpoint standard creation uses, per Phase 0
// research) since Meta's library content is fixed and was never meant to
// route through the free-text creation form at all.
router.post('/meta/:id/use', asyncHandler(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { name, buttonInputs } = useMetaLibraryTemplateSchema.parse(req.body);

  const entry = await metaTemplateLibraryRepo.findById(req.db, id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  // Defense in depth against the id itself being stale/tampered — the
  // client-facing GET /meta above never returns a parameterized entry, so
  // this should be unreachable in normal use, but the actual constraint
  // (no positional-param substitution exists anywhere in this codebase)
  // lives here, not just in what the listing endpoint happens to filter.
  if ((entry.body_params || []).length > 0) {
    return res.status(400).json({
      error: 'This library template has variables, which aren\'t supported yet',
      detail: 'Only variable-free Meta library templates can be used right now.',
    });
  }

  // Checked before validating the shape of what was submitted — whether
  // this client can even submit anything at all is a more fundamental gate
  // than whether their button inputs happen to match this entry.
  const waba = await wabasRepo.findByClientId(req.clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) {
    return res.status(400).json({ error: 'Connect WhatsApp first', detail: 'Using a Meta library template needs a connected WhatsApp number.' });
  }

  const buttonInputMismatch = validateButtonInputsMatchEntry(entry, buttonInputs);
  if (buttonInputMismatch) {
    return res.status(400).json({ error: 'Button destinations don\'t match this template', detail: buttonInputMismatch });
  }

  // Independent audit/QA finding: unlike routes/templates.js's POST / (see
  // messageTemplatesRepo.findActiveByNameAndLanguage's own comment — Meta
  // doesn't cleanly reject a duplicate (name, language) submission, it
  // silently queues it for review, confirmed live to sit unresolved 20+
  // hours), this route had no equivalent pre-check at all. Same guard,
  // same reasoning, applied here.
  const existing = await messageTemplatesRepo.findActiveByNameAndLanguage(req.db, req.clientId, name, entry.language);
  if (existing.length > 0) {
    return res.status(409).json({
      error: 'A template with this name and language already exists',
      detail: 'Choose a different name, or check your existing templates — Meta won\'t cleanly reject a duplicate, it queues indefinitely.',
    });
  }

  let accessToken;
  try {
    accessToken = decrypt(waba.access_token_encrypted);
  } catch (err) {
    return res.status(500).json({
      error: 'Could not decrypt this WABA\'s access token — the request never reached Meta',
      detail: 'SERVER_SECRET in this environment does not match the key that encrypted the stored token.',
    });
  }

  let metaResult;
  try {
    metaResult = await metaClient.createTemplateFromLibrary(waba.waba_id, accessToken, {
      name,
      libraryTemplateName: entry.name,
      language: entry.language,
      buttonInputs,
    });
  } catch (err) {
    return res.status(502).json({
      error: 'Meta rejected this template submission',
      detail: err.message,
      metaError: err.metaError || undefined,
    });
  }

  // Independent audit finding: this previously stored the CACHED entry's
  // own example button destinations (e.g. Meta's catalog placeholder
  // "https://example.com/track") rather than what the client actually
  // submitted — meaning the local record diverged from Meta's real approved
  // content from the moment of creation, and a later edit (routes/templates.js
  // PUT /:id, which resubmits whatever's in this row) could silently revert
  // a real business URL back to Meta's placeholder. Now merges the entry's
  // own type/text (fixed, from Meta) with the client's real submitted
  // destination for each URL/PHONE_NUMBER button — this row is what was
  // actually sent to Meta, not what the catalog happened to show as a
  // sample.
  let buttonInputIndex = 0;
  const submittedButtons = (entry.buttons_json || []).map((b) => {
    if (b.type !== 'URL' && b.type !== 'PHONE_NUMBER') return b;
    const input = buttonInputs[buttonInputIndex++];
    return b.type === 'URL' ? { ...b, url: input.base_url } : { ...b, phone_number: input.phone_number };
  });

  const template = await messageTemplatesRepo.create(req.db, {
    client_id: req.clientId,
    name,
    category: 'Utility',
    status: (metaResult.status || 'pending').toLowerCase(),
    body: entry.body,
    language: entry.language,
    header: entry.header_text ? { type: 'TEXT', text: entry.header_text } : null,
    footer: entry.footer_text || null,
    buttons: submittedButtons.length ? submittedButtons : null,
    meta_template_id: metaResult.id,
  });

  res.status(201).json(template);
}));

module.exports = router;
