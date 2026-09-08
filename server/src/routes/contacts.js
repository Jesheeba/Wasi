const { Router } = require('express');
const multer = require('multer');
const contactsRepo = require('../repositories/contactsRepo');
const consentRepo = require('../repositories/consentRepo');
const contactAttributesRepo = require('../repositories/contactAttributesRepo');
const contactAttributeValuesRepo = require('../repositories/contactAttributeValuesRepo');
const contactTagsRepo = require('../repositories/contactTagsRepo');
const tagsRepo = require('../repositories/tagsRepo');
const contactTimelineRepo = require('../repositories/contactTimelineRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const {
  uuid, contactCreateSchema, contactUpdateSchema, consentEventCreateSchema,
  contactAttributeValueSetSchema, validateContactAttributeValue, contactTagAddSchema,
} = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');
const { parseContactsCsv } = require('../utils/csvContacts');

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

// The only route that can change opt_in_status — deliberately not part of
// the generic PATCH above (see validate.js's consentEventCreateSchema
// comment). Requires a source; writes an immutable consent_events row in
// the same transaction as the status change. consentRepo.recordEvent runs
// on its own privileged connection (see its module comment), not req.db.
router.post('/:id/consent', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = consentEventCreateSchema.parse(req.body);
  const contact = await consentRepo.recordEvent(req.clientId, req.params.id, data);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  res.status(201).json(contact);
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
