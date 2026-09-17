const { Router } = require('express');
const broadcastsRepo = require('../repositories/broadcastsRepo');
const broadcastRecipientsRepo = require('../repositories/broadcastRecipientsRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const contactSegmentsRepo = require('../repositories/contactSegmentsRepo');
const wabasRepo = require('../repositories/wabasRepo');
const metaClient = require('../utils/metaClient');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, broadcastCreateSchema } = require('../utils/validate');
const { extractPlaceholders } = require('../utils/templateParams');
const { requireRole } = require('../middleware/requireRole');
const { compileFilter, UnknownAttributeError, InvalidConditionError, SEGMENT_QUERY_TIMEOUT_MS } = require('../utils/segmentFilter');
const { describeMessageFailure } = require('../utils/metaMessageErrorMessages');
const { toCsv } = require('../utils/csvExport');

const router = Router();

// Real data, not a fabricated dedup count: distinct conversation THREADS
// this client has actually messaged (outbound) in the last rolling 24h.
// Counts distinct chat_id, not contact_id — a chats row's contact_id is
// nullable (a chat doesn't require a linked contacts row), and
// COUNT(DISTINCT contact_id) silently ignores NULLs, which would undercount
// (or zero out) any chat never linked to a contact. chat_id already
// uniquely identifies one conversation thread regardless of that linkage,
// so it needs no join to chats at all. Deliberately an APPROXIMATION of
// Meta's own conversation-billing count, not an exact match — it doesn't
// replicate Meta's marketing/service conversation-window dedup rules, just
// counts real sends. Documented as such everywhere this number is surfaced
// (see tierWarning below and the /tier-status route), matching this
// codebase's own established discipline (see routes/analytics.js's
// cost-estimate endpoint) of never claiming precision the app doesn't have.
async function usedConversationsLast24h(db, clientId) {
  const { rows } = await db.query(
    `select count(distinct chat_id)::int as used
     from messages
     where client_id = $1 and direction = 'out' and sent_at >= now() - interval '24 hours'`,
    [clientId]
  );
  return rows[0].used;
}

// Shared by the /tier-status route (called when the New Campaign modal
// opens, before any audience is even picked) and the POST / preflight
// warning below (once the real audience size is known) — same numbers,
// two different callers.
async function computeTierStatus(db, clientId) {
  const waba = await wabasRepo.findByClientId(clientId);
  const tier = waba?.messaging_tier || null;
  const cap = tier ? metaClient.messagingTierCap(tier) : null;
  if (!tier || cap === null) {
    // Unknown tier (never checked, or Meta returned something this app
    // doesn't recognize) — never claim a limit we don't actually know.
    return { tier, unlimited: false, capNumber: null, usedToday: null, remaining: null, tierCheckedAt: waba?.messaging_tier_checked_at || null };
  }
  const unlimited = cap === Infinity;
  // JSON can't carry Infinity (JSON.stringify(Infinity) === "null"), so
  // capNumber/remaining stay null for the unlimited case too — `unlimited`
  // is the field that disambiguates "no numeric cap because unlimited" from
  // "no numeric cap because unknown" for every caller.
  const usedToday = await usedConversationsLast24h(db, clientId);
  const remaining = unlimited ? null : Math.max(0, cap - usedToday);
  return { tier, unlimited, capNumber: unlimited ? null : cap, usedToday, remaining, tierCheckedAt: waba.messaging_tier_checked_at };
}

router.get('/tier-status', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  res.json(await computeTierStatus(req.db, req.clientId));
}));

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

  // Real-time messaging-tier preflight warning (CLAUDE.md Known Gaps —
  // "real-time Meta tier detection was deliberately not built" until now).
  // Warn-only, same non-blocking pattern as consentWarning above: never
  // blocks broadcast creation, since (a) the tier is often unknown until
  // first checked and blocking on unknown data would be fabricating a limit
  // this app doesn't actually know, and (b) there's no rollback path for the
  // broadcast/recipient rows already created above. Computed here, not
  // before creation, specifically so it needs zero new audience-count
  // queries — recipients.length is already known.
  let tierWarning = null;
  if (recipients.length > 0) {
    const tierStatus = await computeTierStatus(req.db, req.clientId);
    if (tierStatus.remaining !== null && recipients.length > tierStatus.remaining) {
      const capLabel = tierStatus.capNumber !== null ? `${tierStatus.capNumber.toLocaleString()} conversations/24h` : 'an unlimited cap';
      tierWarning = `Your account's messaging tier (${tierStatus.tier}, ${capLabel}) has ~${tierStatus.remaining.toLocaleString()} remaining today — this broadcast's ${recipients.length.toLocaleString()} recipients may exceed it, and some sends could be rejected by WhatsApp. This is an estimate based on this app's own send history, not a live count from Meta.`;
    }
  }

  // broadcastRunner.js (started in index.js) picks up 'Sending' broadcasts'
  // pending recipients on its next tick — no synchronous send here, so this
  // returns immediately even for a large audience.
  res.status(201).json({ ...broadcast, recipient_count: recipients.length, consentWarning, tierWarning });
}));

const RECIPIENT_STATUSES = ['pending', 'sent', 'delivered', 'read', 'failed', 'skipped'];

// broadcastRunner.js's markSkipped is called with one of two shapes: the
// literal string 'smart_sending_window' (a fixed reason code, not meant to
// be shown raw), or a real MessagingError message for a consent skip
// (already human-readable — see messagingService's assertConsentForTemplate)
// — passed through as-is.
function describeSkipReason(reason) {
  if (reason === 'smart_sending_window') {
    return 'This contact already received a broadcast recently — skipped by this campaign\'s Smart Sending window.';
  }
  return reason || 'Skipped — not opted in to marketing messages.';
}

// Shapes one listByBroadcast() row for the API response. `reason` is only
// ever populated for failed/skipped — everything else has nothing to
// explain. A failed row's Meta error code only exists when the failure
// happened AFTER Meta accepted the send (message_error_reason/
// meta_error_code, from the status webhook); a pre-send failure (contact
// deleted, retries exhausted) only ever has recipient_error_reason, hence
// preferring the message-level fields but falling back to the
// recipient-level one.
function shapeRecipient(row) {
  const shaped = {
    id: row.recipient_id,
    contactId: row.contact_id,
    name: row.contact_name || null,
    phone: row.contact_phone || null,
    status: row.effective_status,
    at: row.status_at,
    reason: null,
  };
  if (row.effective_status === 'failed') {
    shaped.reason = describeMessageFailure({
      metaErrorCode: row.meta_error_code,
      errorReason: row.message_error_reason || row.recipient_error_reason,
    });
  } else if (row.effective_status === 'skipped') {
    shaped.reason = describeSkipReason(row.recipient_error_reason);
  }
  return shaped;
}

// PLAN.md item 28 — broadcast detail view metadata + header-strip counts.
router.get('/:id', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const broadcast = await broadcastsRepo.findByIdWithStats(req.db, req.clientId, req.params.id);
  if (!broadcast) return res.status(404).json({ error: 'Not found' });
  res.json(broadcast);
}));

// PLAN.md item 28 — the per-recipient table. No pagination: matches this
// app's existing convention (contacts/chats lists are unpaginated too), and
// a broadcast's own audience size is bounded by this app's real scale
// (thousands, not millions). status/search are optional server-side
// filters — the frontend can also filter/search client-side over the full
// returned set, but passing them avoids shipping the whole list for a
// narrow view (e.g. "just the failed ones").
router.get('/:id/recipients', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const broadcast = await broadcastsRepo.findById(req.db, req.clientId, req.params.id);
  if (!broadcast) return res.status(404).json({ error: 'Not found' });
  const status = RECIPIENT_STATUSES.includes(req.query.status) ? req.query.status : null;
  const search = typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim() : null;
  const rows = await broadcastRecipientsRepo.listByBroadcast(req.db, req.clientId, broadcast.id, { status, search });
  res.json(rows.map(shapeRecipient));
}));

// PLAN.md item 28 — "Export the failed list as CSV." Defaults to 'failed'
// (the one export the spec actually asked for) but honors an explicit
// ?status= so it isn't a bespoke one-off query — it's the exact same
// listByBroadcast() the table itself uses.
router.get('/:id/recipients/export', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const broadcast = await broadcastsRepo.findById(req.db, req.clientId, req.params.id);
  if (!broadcast) return res.status(404).json({ error: 'Not found' });
  const status = RECIPIENT_STATUSES.includes(req.query.status) ? req.query.status : 'failed';
  const rows = await broadcastRecipientsRepo.listByBroadcast(req.db, req.clientId, broadcast.id, { status });
  const csv = toCsv(
    [
      { key: 'name', header: 'Name' },
      { key: 'phone', header: 'Phone' },
      { key: 'status', header: 'Status' },
      { key: 'at', header: 'Timestamp' },
      { key: 'reason', header: 'Reason' },
    ],
    rows.map(shapeRecipient)
  );
  const safeTitle = broadcast.title.replace(/[^a-z0-9]+/gi, '_').toLowerCase() || 'broadcast';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_${status}_recipients.csv"`);
  res.send(csv);
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
