const { Router } = require('express');
const crypto = require('crypto');
const multer = require('multer');
const contactsRepo = require('../repositories/contactsRepo');
const consentRepo = require('../repositories/consentRepo');
const contactAttributesRepo = require('../repositories/contactAttributesRepo');
const contactAttributeValuesRepo = require('../repositories/contactAttributeValuesRepo');
const contactTagsRepo = require('../repositories/contactTagsRepo');
const tagsRepo = require('../repositories/tagsRepo');
const contactTimelineRepo = require('../repositories/contactTimelineRepo');
const auditLogRepo = require('../repositories/auditLogRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const {
  uuid, contactCreateSchema, contactUpdateSchema, consentEventCreateSchema,
  bulkConsentOptInSchema, contactAttributeValueSetSchema, validateContactAttributeValue, contactTagAddSchema, bulkContactTagsSchema,
  CONSENT_METHODS,
} = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');
const { parseContactsCsv } = require('../utils/csvContacts');
const { CONSENT_STATEMENT } = require('../utils/consentStatement');

const router = Router();

// Same size cap/reasoning as contactLists.js's identical uploadCsv -
// plain text, a contact export is a handful of KB to a few MB even at tens
// of thousands of rows.
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get('/', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  const [contacts, tagIds] = await Promise.all([
    contactsRepo.list(req.db, req.clientId),
    contactTagsRepo.tagIdsByContact(req.db, req.clientId),
  ]);
  res.json(contacts.map((c) => ({ ...c, tag_ids: tagIds.get(c.id) || [] })));
}));

// Bulk tagging from the Contacts view's selection bar. Same roles as the
// per-contact tag routes below (tagging is day-to-day work, Agents included).
router.post('/bulk-tags', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  const { contactIds, tagId, action } = bulkContactTagsSchema.parse(req.body);
  const tag = await tagsRepo.findById(req.db, req.clientId, tagId);
  if (!tag) return res.status(404).json({ error: 'Tag not found' });

  const ids = [...new Set(contactIds)];
  const changed = action === 'add'
    ? await contactTagsRepo.addMany(req.db, req.clientId, ids, tagId)
    : await contactTagsRepo.removeMany(req.db, req.clientId, ids, tagId);
  res.json({ action, tag: { id: tag.id, name: tag.name }, selected: ids.length, changed });
}));

router.get('/:id', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const contact = await contactsRepo.findById(req.db, req.clientId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.json(contact);
}));

router.post('/', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  const data = contactCreateSchema.parse(req.body);
  const contact = await contactsRepo.create(req.db, req.clientId, data);
  res.status(201).json(contact);
}));

// PLAN.md item 6 - reuses contactLists.js's own CSV-parsing utility
// (csvContacts.js's parseContactsCsv, name/phone columns, case-insensitive
// header, RFC4180-ish quoting) rather than a second parser; unlike that
// route, there's no list/membership concept here at all, just contacts.
//
// PLAN.md item 8 fold-in: { includeTags: true } makes the shared parser
// also read a "tags" column (semicolon-separated names) instead of
// reporting it as unrecognized - this route is the one CSV-import path
// that now has somewhere real to put it (contact_tags). Each parsed tag
// name is find-or-created (tagsRepo.findOrCreateByName) then additively
// attached (contactTagsRepo.add) - never touches contacts.tag_id, the
// permanent primary tag, matching item 8's own additive-only design.
//
// Consent hardening Phase 3 (CSV opt-in, 2026-11-23) - the approved shape
// (CLAUDE.md's consent Known Gaps entry): a per-row "opt_in" column, or a
// file-level "all rows in this file are opted in" option, both gated by
// the SAME explicit confirmation this app already requires for bulk/
// per-contact opt-in (bulkConsentOptInSchema's method+confirmed, the
// CONSENT_STATEMENT, Admin/Manager only - never Agent, matching the
// already-approved "who may attest" decision). These are plain multipart
// form fields (optInMethod/optInConfirmed/allRowsOptedIn), not JSON - this
// route has never had a JSON `data` field the way templates.js's media
// routes do, and adding one here for 3 small fields isn't worth the extra
// parsing layer. Nothing about consent is inferred from the column's mere
// presence: csvContacts.js's parser itself refuses to even READ the
// opt_in column unless includeOptIn is passed, which only happens below
// once optInConfirmed is genuinely true - the column is otherwise reported
// as an ignored, unrecognized one (see that file's own comment), so a
// CSV with a stray "opt_in" header can never silently opt anyone in.
router.post('/import', requireRole('Admin', 'Manager', 'Agent'), uploadCsv.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded - expected a "file" field containing a CSV.' });
  }

  const optInConfirmed = req.body.optInConfirmed === 'true';
  const optInMethod = req.body.optInMethod;
  const allRowsOptedIn = req.body.allRowsOptedIn === 'true';

  if (optInConfirmed || allRowsOptedIn) {
    if (req.actorType === 'team_member' && req.actorRole === 'Agent') {
      return res.status(403).json({ error: 'Agents can import contacts, but not mark them opted in from a CSV - that needs Admin, Manager, or Owner.' });
    }
    if (!optInConfirmed) {
      return res.status(400).json({ error: '"All rows in this file are opted in" requires the same explicit consent confirmation as marking individual rows opted in.' });
    }
    if (!CONSENT_METHODS.includes(optInMethod)) {
      return res.status(400).json({ error: `optInMethod must be one of: ${CONSENT_METHODS.join(', ')}` });
    }
  }
  const includeOptIn = optInConfirmed;

  const { validRows, errors } = parseContactsCsv(req.file.buffer.toString('utf8'), { includeTags: true, includeOptIn });
  const imported = await contactsRepo.importFromRows(req.db, req.clientId, validRows);

  const contactIdByPhone = Object.fromEntries(imported.map((c) => [c.phone, c.id]));
  for (const row of validRows) {
    if (!row.tags || !row.tags.length) continue;
    const contactId = contactIdByPhone[row.phone];
    for (const tagName of row.tags) {
      const tag = await tagsRepo.findOrCreateByName(req.db, req.clientId, tagName);
      await contactTagsRepo.add(req.db, req.clientId, contactId, tag.id);
    }
  }

  let optInResult = null;
  if (includeOptIn) {
    const rowsToOptIn = validRows.filter((row) => allRowsOptedIn || row.optIn);
    const batchId = crypto.randomUUID();
    const actorType = req.actorType;
    const actorId = req.actorType === 'team_member' ? req.actorId : null;
    const evidence = { statement: CONSENT_STATEMENT, method: optInMethod, note: req.body.optInNote || null, source: 'csv_import' };

    // importFromRows only returns {id, phone} - fetched separately here
    // (not a gate, just an honest updated/alreadyOptedIn split; same
    // caveat as bulk-consent above: recordEvent's own row lock is the
    // real authority on whether a write is allowed, not this pre-fetch).
    const optInIds = rowsToOptIn.map((row) => contactIdByPhone[row.phone]);
    const currentStatusById = optInIds.length
      ? Object.fromEntries((await contactsRepo.findManyByIds(req.db, req.clientId, optInIds)).map((c) => [c.id, c.opt_in_status]))
      : {};

    // A real bug, found live (not reasoned about) while verifying this
    // feature: req.db runs this whole request inside one transaction
    // (tenantContext.js, BEGIN at request start, COMMIT after the handler
    // returns), but consentRepo.recordEvent opens its OWN separate
    // connection and transaction. Calling it here, before req.db's
    // transaction has committed, means its `select ... for update` on a
    // contact row THIS SAME REQUEST just inserted finds nothing - a brand
    // new row is invisible across connections until its own transaction
    // commits. recordEvent then silently ROLLBACKs and returns null (its
    // documented "not found" behavior), which this route was counting as
    // a success. Same fix templates.js already established for a Meta
    // call that needs to see data written earlier in the same request:
    // commit and release req.db before anything that needs a separate
    // connection to see it. Nothing after this point in the route uses
    // req.db, so there is no reacquire.
    await req.commitAndRelease();

    let updated = 0;
    let alreadyOptedIn = 0;
    let skippedOptedOut = 0;
    for (const row of rowsToOptIn) {
      const contactId = contactIdByPhone[row.phone];
      if (currentStatusById[contactId] === 'opted_in') { alreadyOptedIn += 1; continue; }
      try {
        // recordEvent returns null (not a thrown error) if it can't find
        // the contact row - checked explicitly so that case can never
        // again be silently miscounted as a success (see the comment above
        // this loop for the real bug this guards against recurring).
        const result = await consentRepo.recordEvent(req.clientId, contactId, {
          event: 'opted_in', source: 'csv_import', evidence, actorType, actorId, batchId,
        });
        if (result) updated += 1;
      } catch (err) {
        if (err instanceof consentRepo.ConsentBlockedError) { skippedOptedOut += 1; continue; }
        throw err;
      }
    }
    optInResult = { batchId, total: rowsToOptIn.length, updated, alreadyOptedIn, skippedOptedOut };

    if (updated > 0) {
      await auditLogRepo.record({
        actor_type: 'client', actor_id: req.clientId,
        action: 'contacts_csv_opt_in',
        target: `${req.clientId}: ${updated} contact(s) marked opted in via CSV import, batch ${batchId}`,
      });
    }
  }

  // A header-level 'unrecognized_column' notice (e.g. an ignored
  // truly-unknown column) is still shown in errors below, but doesn't
  // correspond to any one failed row - excluded from failedCount so it
  // doesn't misreport "N rows failed" when every row actually imported fine.
  const failedRows = errors.filter((e) => e.type !== 'unrecognized_column');
  res.json({
    importedCount: validRows.length,
    failedCount: failedRows.length,
    errors,
    optIn: optInResult,
  });
}));

router.patch('/:id', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = contactUpdateSchema.parse(req.body);
  const contact = await contactsRepo.update(req.db, req.clientId, req.params.id, data);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.json(contact);
}));

router.delete('/:id', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const deleted = await contactsRepo.remove(req.db, req.clientId, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

// Consent hardening Phase 2 - bulk "Mark as opted in," gated to
// Owner/Admin/Manager only (requireRole's own list excludes Agent
// entirely; Owner always passes regardless of the list - see
// middleware/requireRole.js). Every id in contactIds is attempted
// independently - one bad/blocked id must never abort the rest of the
// batch, matching this codebase's own established "one bad row can't kill
// the batch" discipline (contactListsRepo.addMembersFromRows,
// broadcastRunner's per-broadcast try/catch, etc.). A shared batchId
// (migration 077's consent_events.batch_id) lets every row this one
// confirmation produced be found together later.
//
// findManyByIds is fetched up front purely to report an honest
// updated/alreadyOptedIn split without a wasted recordEvent call for a
// contact that's already opted_in - it is NOT the authority on whether a
// write is allowed. consentRepo.recordEvent's own row lock is: a contact
// that looked 'unknown' in this pre-fetch but gets a real inbound STOP
// between the fetch and this specific row's write still lands in
// skippedOptedOut, not updated, because recordEvent re-checks fresh under
// FOR UPDATE regardless of what this route assumed.
router.post('/bulk-consent', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  const data = bulkConsentOptInSchema.parse(req.body);
  const contacts = await contactsRepo.findManyByIds(req.db, req.clientId, data.contactIds);
  const foundIds = new Set(contacts.map((c) => c.id));

  const batchId = crypto.randomUUID();
  const actorType = req.actorType;
  const actorId = req.actorType === 'team_member' ? req.actorId : null;
  const evidence = { statement: CONSENT_STATEMENT, method: data.method, note: data.note || null };

  let updated = 0;
  let alreadyOptedIn = 0;
  let skippedOptedOut = 0;
  const notFound = data.contactIds.length - foundIds.size;

  for (const contact of contacts) {
    if (contact.opt_in_status === 'opted_in') {
      alreadyOptedIn += 1;
      continue;
    }
    try {
      await consentRepo.recordEvent(req.clientId, contact.id, {
        event: 'opted_in', source: 'bulk_ui', evidence, actorType, actorId, batchId,
      });
      updated += 1;
    } catch (err) {
      if (err instanceof consentRepo.ConsentBlockedError) {
        skippedOptedOut += 1;
        continue;
      }
      throw err;
    }
  }

  await auditLogRepo.record({
    actor_type: 'client', actor_id: req.clientId,
    action: 'contacts_bulk_opt_in',
    // "<id>: <description>" convention - matches auditLogRepo.list's own
    // dual-shape match (see that repo's module comment / CLAUDE.md's fixed
    // audit-trail-filter bug) so this shows up on the client's own history
    // the same way every other self-serve action already does.
    target: `${req.clientId}: ${updated} contact(s) marked opted in, batch ${batchId}`,
  });

  res.json({ batchId, total: data.contactIds.length, updated, alreadyOptedIn, skippedOptedOut, notFound });
}));

// The only route that can change opt_in_status for a single contact -
// deliberately not part of the generic PATCH above (see validate.js's
// consentEventCreateSchema comment). Requires a source; writes an
// immutable consent_events row in the same transaction as the status
// change. consentRepo.recordEvent runs on its own privileged connection
// (see its module comment), not req.db.
//
// Consent hardening Phase 1: opted_out is sticky (consentRepo.recordEvent
// throws ConsentBlockedError for an 'opted_in' event against an
// already-opted-out contact) - surfaced here as a 409, not a 500, since a
// client/team member hitting this isn't a server error, it's this route
// correctly refusing to overwrite a real opt-out. actorType/actorId thread
// through so the new consent_events columns (migration 077) are populated.
//
// Consent hardening Phase 2: an Agent may mark a contact opted_out (routine
// day-to-day moderation, matches this route's existing role gate), but
// never opted_in (that needs the same evidence-backed confirmation bulk
// opt-in requires - an Agent has no such flow) - this is a distinction
// requireRole's plain role-list can't express (it's per-event, not
// per-route), so it's checked explicitly here instead. Bulk opt-in above
// doesn't need the equivalent check: its own requireRole list excludes
// Agent entirely, since bulk-by-definition only ever writes opted_in.
router.post('/:id/consent', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = consentEventCreateSchema.parse(req.body);
  if (data.event === 'opted_in' && req.actorType === 'team_member' && req.actorRole === 'Agent') {
    return res.status(403).json({ error: 'Agents can mark a contact opted out, but not opted in - that needs Admin, Manager, or Owner.' });
  }
  try {
    const contact = await consentRepo.recordEvent(req.clientId, req.params.id, {
      ...data,
      actorType: req.actorType,
      actorId: req.actorType === 'team_member' ? req.actorId : null,
    });
    if (!contact) return res.status(404).json({ error: 'Not found' });
    res.status(201).json(contact);
  } catch (err) {
    if (err instanceof consentRepo.ConsentBlockedError) {
      return res.status(409).json({ error: err.message });
    }
    throw err;
  }
}));

router.get('/:id/consent', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const contact = await contactsRepo.findById(req.db, req.clientId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.json(await consentRepo.listEventsForContact(req.db, req.clientId, req.params.id));
}));

// PLAN.md item 7 - per-contact custom attribute values.
router.get('/:id/attributes', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const contact = await contactsRepo.findById(req.db, req.clientId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const values = await contactAttributeValuesRepo.listForContact(req.db, req.clientId, req.params.id);
  res.json({ values });
}));

router.put('/:id/attributes/:attributeId', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  uuid.parse(req.params.attributeId);
  const { value } = contactAttributeValueSetSchema.parse(req.body);

  const contact = await contactsRepo.findById(req.db, req.clientId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const attribute = await contactAttributesRepo.findById(req.db, req.clientId, req.params.attributeId);
  if (!attribute) return res.status(404).json({ error: 'Not found' });

  if (!validateContactAttributeValue(attribute.type, value)) {
    return res.status(400).json({
      error: `"${value}" is not a valid ${attribute.type} value for "${attribute.name}".`,
    });
  }

  const saved = await contactAttributeValuesRepo.upsert(req.db, req.clientId, req.params.id, req.params.attributeId, value);
  res.json({ attributeId: saved.attributeId, name: attribute.name, type: attribute.type, value: saved.value });
}));

// PLAN.md item 8 - multi-tag contacts, additive to contacts.tag_id (the
// permanent primary tag - unaffected by any of these three routes). Same
// role gating as attributes above: read/write is Admin/Manager/Agent,
// matching Contacts' own row for day-to-day tagging use, not Contacts'
// stricter Admin/Manager-only DELETE (which removes the whole contact, a
// different and more destructive action than detaching one tag).
router.get('/:id/tags', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const contact = await contactsRepo.findById(req.db, req.clientId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.json({ tags: await contactTagsRepo.listForContact(req.db, req.clientId, req.params.id) });
}));

router.post('/:id/tags', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const { tagId } = contactTagAddSchema.parse(req.body);

  const contact = await contactsRepo.findById(req.db, req.clientId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const tag = await tagsRepo.findById(req.db, req.clientId, tagId);
  if (!tag) return res.status(404).json({ error: 'Tag not found' });

  await contactTagsRepo.add(req.db, req.clientId, req.params.id, tagId);
  res.status(201).json({ tags: await contactTagsRepo.listForContact(req.db, req.clientId, req.params.id) });
}));

router.delete('/:id/tags/:tagId', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  uuid.parse(req.params.tagId);
  const contact = await contactsRepo.findById(req.db, req.clientId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });

  const removed = await contactTagsRepo.remove(req.db, req.clientId, req.params.id, req.params.tagId);
  if (!removed) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

// PLAN.md item 10 - Contact 360 activity timeline. Read-only, no schema
// change; merges messages/broadcast sends/flow entries/consent events.
router.get('/:id/timeline', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const contact = await contactsRepo.findById(req.db, req.clientId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const events = await contactTimelineRepo.getTimeline(req.db, req.clientId, req.params.id);
  res.json({ events });
}));

module.exports = router;
