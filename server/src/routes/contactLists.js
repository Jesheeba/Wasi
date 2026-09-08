// Contact Lists (wasi-master-plan.md §8.3) — CSV-importable, reusable
// audience targeting for broadcasts, alongside the existing single-tag
// selector (routes/broadcasts.js's tag_id path, unchanged). No submission
// logic here — this only creates contact_lists/contact_list_members rows;
// a broadcast created against one of these still sends through the
// existing broadcastRunner.js -> messagingService.sendChatMessage path.
const { Router } = require('express');
const multer = require('multer');
const contactListsRepo = require('../repositories/contactListsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, contactListCreateSchema } = require('../utils/validate');
const { parseContactsCsv } = require('../utils/csvContacts');

const router = Router();

// Plain text, small — a contact export is a handful of KB to a few MB even
// at tens of thousands of rows; 5MB is generous headroom without inviting
// an accidental huge upload to block the request thread parsing it.
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get('/', asyncHandler(async (req, res) => {
  res.json(await contactListsRepo.listByClientId(req.db, req.clientId));
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name } = contactListCreateSchema.parse(req.body);
  const list = await contactListsRepo.create(req.db, req.clientId, { name, source: 'manual' });
  res.status(201).json(list);
}));

// Every row is accounted for: imported (added as a new member), or
// rejected with a specific reason (missing/invalid phone, duplicate within
// the file) — never silently dropped. Matches the "reject visibly with a
// structured list of specific problems" convention already established by
// routes/broadcasts.js's param-mapping validation and the Hub API's error
// shape, rather than inventing a new error-reporting pattern for CSV
// specifically.
router.post('/:id/import', uploadCsv.single('file'), asyncHandler(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const list = await contactListsRepo.findById(req.db, req.clientId, id);
  if (!list) return res.status(404).json({ error: 'Not found' });

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded — expected a "file" field containing a CSV.' });
  }

  const { validRows, errors } = parseContactsCsv(req.file.buffer.toString('utf8'));
  const added = await contactListsRepo.addMembersFromRows(req.db, req.clientId, id, validRows);

  res.json({
    list_id: id,
    rows_in_file: validRows.length + errors.length,
    imported: added,
    already_in_list: validRows.length - added,
    rejected: errors.length,
    errors,
  });
}));

module.exports = router;
