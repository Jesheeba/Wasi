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

module.exports = router;
