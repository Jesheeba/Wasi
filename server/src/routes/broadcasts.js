const { Router } = require('express');
const broadcastsRepo = require('../repositories/broadcastsRepo');
const broadcastRecipientsRepo = require('../repositories/broadcastRecipientsRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const contactSegmentsRepo = require('../repositories/contactSegmentsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, broadcastCreateSchema } = require('../utils/validate');
const { extractPlaceholders } = require('../utils/templateParams');
const { requireRole } = require('../middleware/requireRole');
const { compileFilter, UnknownAttributeError, InvalidConditionError, SEGMENT_QUERY_TIMEOUT_MS } = require('../utils/segmentFilter');

const router = Router();

router.get('/', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
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

router.post('/', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  const { templateName, paramMappings, headerMediaAssetId, pacingConfig, smartSendingHours, ...data } = broadcastCreateSchema.parse(req.body);

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

  // PLAN.md item 9 — resolved BEFORE creating the broadcast row, so a bad
  // segment_id 404s cleanly instead of leaving an orphaned/empty broadcast
  // behind. Only a segment's filter_json needs this pre-fetch; tag_id/
  // contact_list_id are still validated inline by their own existing
  // functions below (contact_list_id silently matches zero rows for a
  // foreign list, same pre-existing behavior, unchanged by this item).
  let segmentFilter = null;
  if (data.segment_id) {
    const segment = await contactSegmentsRepo.findById(req.db, req.clientId, data.segment_id);
    if (!segment) return res.status(404).json({ error: 'Segment not found' });
    const attributeIds = [...new Set(segment.filter_json.conditions.filter((c) => c.field === 'attribute').map((c) => c.attributeId))];
    const attributeTypesById = attributeIds.length
      ? new Map((await req.db.query('select id, type from contact_attributes where client_id = $1 and id = any($2::uuid[])', [req.clientId, attributeIds])).rows.map((r) => [r.id, r.type]))
      : new Map();
    try {
      // paramOffset: 2 — broadcastId/clientId will be $1/$2 in
      // createFromSegment's INSERT below, this filter's own placeholders
      // continue from $3.
      segmentFilter = compileFilter(segment.filter_json, { attributeTypesById, paramOffset: 2 });
    } catch (err) {
      if (err instanceof UnknownAttributeError || err instanceof InvalidConditionError) {
        return res.status(400).json({ error: `This segment's filter is no longer valid: ${err.message}` });
      }
      throw err;
    }
  }

  const broadcast = await broadcastsRepo.create(req.db, req.clientId, {
    ...data, template_name: templateName, param_mappings: paramMappings, header_media_asset_id: headerMediaAssetId,
    pacing_config: pacingConfig, smart_sending_hours: smartSendingHours,
  });
  // Audience source: contact_list_id, then segment_id, else the existing
  // tag_id path (null tag_id there already means "everyone" — unchanged).
  // Mutually exclusive, enforced by broadcastCreateSchema's superRefine and
  // the DB's own CHECK constraint (migration 051, widened from 039's
  // 2-column version). The segment branch scans the whole contacts table
  // (same reasoning as the /preview route's own comment) — same
  // SET LOCAL statement_timeout protection applied here too, since
  // creating a broadcast against a segment runs the identical class of
  // query, just as an INSERT...SELECT instead of a COUNT.
  let recipients;
  if (data.contact_list_id) {
    recipients = await broadcastRecipientsRepo.createFromList(req.db, broadcast.id, req.clientId, data.contact_list_id);
  } else if (segmentFilter) {
    try {
      await req.db.query(`set local statement_timeout = '${SEGMENT_QUERY_TIMEOUT_MS}ms'`);
      recipients = await broadcastRecipientsRepo.createFromSegment(req.db, broadcast.id, req.clientId, segmentFilter.sql, segmentFilter.params);
    } catch (err) {
      if (err.code === '57014') {
        return res.status(503).json({
          error: 'This segment\'s filter is too broad or complex to resolve into a broadcast right now. Try narrowing it, or preview it first to check it completes.',
        });
      }
      throw err;
    }
  } else {
    recipients = await broadcastRecipientsRepo.createFromAudience(req.db, broadcast.id, req.clientId, data.tag_id);
  }
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

// PLAN.md item 11 — no schema change: broadcasts.status is plain text with
// no CHECK constraint, and broadcastRunner.js's claimBatch/listActive only
// ever match status = 'Sending' exactly, so pausing is just setting status
// to anything else — the runner's next 5s tick naturally stops claiming
// new batches for it. A batch already claimed (FOR UPDATE SKIP LOCKED)
// before a pause request lands still finishes sending — this can't be
// interrupted mid-flight and shouldn't be (a half-sent batch stuck
// 'pending' forever would be worse). Matches the reference spec's own
// described mechanism (§10.1: "the worker checks the campaign status flag
// ... before executing each contact batch").
router.post('/:id/pause', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const broadcast = await broadcastsRepo.findById(req.db, req.clientId, req.params.id);
  if (!broadcast) return res.status(404).json({ error: 'Not found' });
  if (broadcast.status !== 'Sending') {
    return res.status(400).json({ error: `Cannot pause a broadcast with status "${broadcast.status}" — only one currently "Sending" can be paused.` });
  }
  await broadcastsRepo.markStatus(req.db, broadcast.id, 'Paused');
  res.json({ id: broadcast.id, status: 'Paused' });
}));

router.post('/:id/resume', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const broadcast = await broadcastsRepo.findById(req.db, req.clientId, req.params.id);
  if (!broadcast) return res.status(404).json({ error: 'Not found' });
  if (broadcast.status !== 'Paused') {
    return res.status(400).json({ error: `Cannot resume a broadcast with status "${broadcast.status}" — only one currently "Paused" can be resumed.` });
  }
  await broadcastsRepo.markStatus(req.db, broadcast.id, 'Sending');
  res.json({ id: broadcast.id, status: 'Sending' });
}));

module.exports = router;
