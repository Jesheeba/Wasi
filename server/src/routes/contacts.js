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
  bulkConsentOptInSchema, contactAttributeValueSetSchema, validateContactAttributeValue, contactTagAddSchema,
} = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');
const { parseContactsCsv } = require('../utils/csvContacts');
const { CONSENT_STATEMENT } = require('../utils/consentStatement');

const router = Router();

// Same size cap/reasoning as contactLists.js's identical uploadCsv —
// plain text, a contact export is a handful of KB to a few MB even at tens
// of thousands of rows.
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get('/', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  res.json(await contactsRepo.list(req.db, req.clientId));
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

// PLAN.md item 6 — reuses contactLists.js's own CSV-parsing utility
// (csvContacts.js's parseContactsCsv, name/phone columns, case-insensitive
// header, RFC4180-ish quoting) rather than a second parser; unlike that
// route, there's no list/membership concept here at all, just contacts.
//
// PLAN.md item 8 fold-in: { includeTags: true } makes the shared parser
// also read a "tags" column (semicolon-separated names) instead of
// reporting it as unrecognized — this route is the one CSV-import path
// that now has somewhere real to put it (contact_tags). Each parsed tag
// name is find-or-created (tagsRepo.findOrCreateByName) then additively
// attached (contactTagsRepo.add) — never touches contacts.tag_id, the
// permanent primary tag, matching item 8's own additive-only design.
router.post('/import', requireRole('Admin', 'Manager', 'Agent'), uploadCsv.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded — expected a "file" field containing a CSV.' });
  }
  const { validRows, errors } = parseContactsCsv(req.file.buffer.toString('utf8'), { includeTags: true });
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

  // A header-level 'unrecognized_column' notice (e.g. an ignored
  // truly-unknown column) is still shown in errors below, but doesn't
  // correspond to any one failed row — excluded from failedCount so it
  // doesn't misreport "N rows failed" when every row actually imported fine.
  const failedRows = errors.filter((e) => e.type !== 'unrecognized_column');
  res.json({
    importedCount: validRows.length,
    failedCount: failedRows.length,
    errors,
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

// Consent hardening Phase 2 — bulk "Mark as opted in," gated to
// Owner/Admin/Manager only (requireRole's own list excludes Agent
// entirely; Owner always passes regardless of the list — see
// middleware/requireRole.js). Every id in contactIds is attempted
// independently — one bad/blocked id must never abort the rest of the
// batch, matching this codebase's own established "one bad row can't kill
// the batch" discipline (contactListsRepo.addMembersFromRows,
// broadcastRunner's per-broadcast try/catch, etc.). A shared batchId
// (migration 077's consent_events.batch_id) lets every row this one
// confirmation produced be found together later.
//
// findManyByIds is fetched up front purely to report an honest
// updated/alreadyOptedIn split without a wasted recordEvent call for a
// contact that's already opted_in — it is NOT the authority on whether a
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
    // "<id>: <description>" convention — matches auditLogRepo.list's own
    // dual-shape match (see that repo's module comment / CLAUDE.md's fixed
    // audit-trail-filter bug) so this shows up on the client's own history
    // the same way every other self-serve action already does.
    target: `${req.clientId}: ${updated} contact(s) marked opted in, batch ${batchId}`,
  });

  res.json({ batchId, total: data.contactIds.length, updated, alreadyOptedIn, skippedOptedOut, notFound });
}));

// The only route that can change opt_in_status for a single contact —
// deliberately not part of the generic PATCH above (see validate.js's
// consentEventCreateSchema comment). Requires a source; writes an
// immutable consent_events row in the same transaction as the status
// change. consentRepo.recordEvent runs on its own privileged connection
// (see its module comment), not req.db.
//
// Consent hardening Phase 1: opted_out is sticky (consentRepo.recordEvent
// throws ConsentBlockedError for an 'opted_in' event against an
// already-opted-out contact) — surfaced here as a 409, not a 500, since a
// client/team member hitting this isn't a server error, it's this route
// correctly refusing to overwrite a real opt-out. actorType/actorId thread
// through so the new consent_events columns (migration 077) are populated.
//
// Consent hardening Phase 2: an Agent may mark a contact opted_out (routine
// day-to-day moderation, matches this route's existing role gate), but
// never opted_in (that needs the same evidence-backed confirmation bulk
// opt-in requires — an Agent has no such flow) — this is a distinction
// requireRole's plain role-list can't express (it's per-event, not
// per-route), so it's checked explicitly here instead. Bulk opt-in above
// doesn't need the equivalent check: its own requireRole list excludes
// Agent entirely, since bulk-by-definition only ever writes opted_in.
router.post('/:id/consent', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = consentEventCreateSchema.parse(req.body);
  if (data.event === 'opted_in' && req.actorType === 'team_member' && req.actorRole === 'Agent') {
    return res.status(403).json({ error: 'Agents can mark a contact opted out, but not opted in — that needs Admin, Manager, or Owner.' });
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

// PLAN.md item 7 — per-contact custom attribute values.
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

// PLAN.md item 8 — multi-tag contacts, additive to contacts.tag_id (the
// permanent primary tag — unaffected by any of these three routes). Same
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

// PLAN.md item 10 — Contact 360 activity timeline. Read-only, no schema
// change; merges messages/broadcast sends/flow entries/consent events.
router.get('/:id/timeline', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const contact = await contactsRepo.findById(req.db, req.clientId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const events = await contactTimelineRepo.getTimeline(req.db, req.clientId, req.params.id);
  res.json({ events });
}));

module.exports = router;
