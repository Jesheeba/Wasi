const { Router } = require('express');
const broadcastsRepo = require('../repositories/broadcastsRepo');
const broadcastRecipientsRepo = require('../repositories/broadcastRecipientsRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { broadcastCreateSchema } = require('../utils/validate');
const { extractPlaceholders } = require('../utils/templateParams');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await broadcastsRepo.list(req.db, req.clientId));
}));

// Every {{param}} in the template's body, plus its header if it's a TEXT
// header with a variable — the two places broadcastRunner.js's
// sendOneRecipient actually needs a resolved value for (buildNamedBodyComponents
// / buildNamedHeaderComponents, metaClient.js). Deduped, since a repeated
// {{name}} only needs one mapping entry.
function requiredParamNames(template) {
  const names = extractPlaceholders(template.body).map((m) => m.name);
  if (template.header_type === 'TEXT' && template.header_content) {
    names.push(...extractPlaceholders(template.header_content).map((m) => m.name));
  }
  return [...new Set(names)];
}

router.post('/', asyncHandler(async (req, res) => {
  const { templateName, paramMappings, ...data } = broadcastCreateSchema.parse(req.body);

  // Fetched once, up front — needed for both the param-coverage check below
  // and the consent-category check further down, and (build plan Phase 4)
  // a template with no local row is already treated as Marketing/
  // consent-required elsewhere, so param validation is skipped rather than
  // guessed at when there's nothing to check the mapping against.
  const template = await messageTemplatesRepo.findByNameAndClient(req.db, req.clientId, templateName);

  if (template) {
    const required = requiredParamNames(template);
    const missing = required.filter((name) => !paramMappings || !paramMappings[name]);
    if (missing.length > 0) {
      return res.status(400).json({
        error: 'This template has parameters with no value source.',
        details: missing.map((name) =>
          `"${name}" has no value source — set it to a contact field (e.g. name) or a static value before creating this broadcast.`
        ),
      });
    }
  }

  const broadcast = await broadcastsRepo.create(req.db, req.clientId, {
    ...data, template_name: templateName, param_mappings: paramMappings,
  });
  const recipients = await broadcastRecipientsRepo.createFromAudience(req.db, broadcast.id, req.clientId, data.tag_id);
  if (recipients.length === 0) {
    await broadcastsRepo.markStatus(req.db, broadcast.id, 'Completed');
  }

  // Consent warning (build plan Phase 4) — computed here, before
  // broadcastRunner's next tick actually attempts anything (it skips
  // non-opted-in recipients rather than sending to them, same rule as
  // messagingService.assertConsentForTemplate: unrecognized category fails
  // closed, treated as marketing).
  const requiresConsent = !template || template.category === 'Marketing';
  let consentWarning = null;
  if (requiresConsent && recipients.length > 0) {
    const optedInCount = recipients.filter((r) => r.opt_in_status === 'opted_in').length;
    const notOptedInCount = recipients.length - optedInCount;
    if (notOptedInCount > recipients.length / 2) {
      consentWarning = `${notOptedInCount} of ${recipients.length} recipients have not opted in to marketing messages and will be skipped, not sent.`;
    }
  }

  // broadcastRunner.js (started in index.js) picks up 'Sending' broadcasts'
  // pending recipients on its next tick — no synchronous send here, so this
  // returns immediately even for a large audience.
  res.status(201).json({ ...broadcast, recipient_count: recipients.length, consentWarning });
}));

module.exports = router;
