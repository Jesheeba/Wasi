const { Router } = require('express');
const contactSegmentsRepo = require('../repositories/contactSegmentsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { contactSegmentCreateSchema, contactSegmentPreviewSchema } = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');
const { compileFilter, UnknownAttributeError, InvalidConditionError, SEGMENT_QUERY_TIMEOUT_MS } = require('../utils/segmentFilter');

const router = Router();

// A condition's op/value validity depends on the attribute's REAL declared
// type, which filter_json itself can't be trusted to state accurately —
// one query for every 'attribute' condition's type, not one per condition.
async function attributeTypesFor(db, clientId, filterJson) {
  const attributeIds = [...new Set(filterJson.conditions.filter((c) => c.field === 'attribute').map((c) => c.attributeId))];
  if (!attributeIds.length) return new Map();
  const { rows } = await db.query(
    'select id, type from contact_attributes where client_id = $1 and id = any($2::uuid[])',
    [clientId, attributeIds]
  );
  return new Map(rows.map((r) => [r.id, r.type]));
}

router.get('/', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  res.json(await contactSegmentsRepo.list(req.db, req.clientId));
}));

router.post('/', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  const { name, filterJson } = contactSegmentCreateSchema.parse(req.body);
  const attributeTypesById = await attributeTypesFor(req.db, req.clientId, filterJson);
  try {
    compileFilter(filterJson, { attributeTypesById }); // validated here, run only by preview/broadcast-creation
  } catch (err) {
    if (err instanceof UnknownAttributeError || err instanceof InvalidConditionError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
  const segment = await contactSegmentsRepo.create(req.db, req.clientId, { name, filterJson });
  res.status(201).json(segment);
}));

// PLAN.md item 9, flagged per explicit review request rather than assumed
// fine: this is the one route in the whole app that runs a user-composed
// WHERE clause against the WHOLE contacts table — every other query filters
// by a fixed, known, indexed predicate. Every EXISTS subquery
// segmentFilter.js generates IS index-backed (contact_tags' primary key
// leads with contact_id; contact_attribute_values has an index on
// contact_id — migrations 050/049), so a well-formed filter stays fast even
// at real scale. But an adversarial-or-just-large filter (many OR'd
// conditions against a tenant with a very large contacts table) has no
// hard ceiling on Postgres' planning/execution time otherwise, and this
// codebase has NO existing statement_timeout anywhere (checked: pool.js,
// tenantContext.js) — every other route's queries are cheap by
// construction, so this gap never mattered until now.
//
// Fix: SET LOCAL statement_timeout, scoped to this one query on this one
// request's transaction (tenantContext.js's own SET LOCAL pattern — safe
// under Supavisor's transaction-mode pooling, reverts automatically at
// commit/rollback). A canceled query (Postgres error 57014) surfaces as a
// clear 503, not a hung request or a raw 500 — tenantContext.js's response
// wrapper already rolls back correctly for any status >= 500.
//
// What this does NOT do: make counting itself cheaper. An exact COUNT(*)
// always visits every matching row; a timeout bounds worst-case latency,
// it doesn't reduce the work. At this app's real current scale (CLAUDE.md:
// a handful of clients, hundreds of contacts each) that's sub-second
// regardless of index support. If a tenant ever grows into the hundreds of
// thousands of contacts, an approximate or capped count (e.g. "10,000+")
// would be the next real step — not built here, since it's not
// proportionate to any demonstrated real scale, but stated explicitly
// rather than silently assumed away.
router.post('/preview', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  const { filterJson } = contactSegmentPreviewSchema.parse(req.body);
  const attributeTypesById = await attributeTypesFor(req.db, req.clientId, filterJson);

  let sql, params;
  try {
    ({ sql, params } = compileFilter(filterJson, { attributeTypesById, paramOffset: 1 }));
  } catch (err) {
    if (err instanceof UnknownAttributeError || err instanceof InvalidConditionError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  try {
    await req.db.query(`set local statement_timeout = '${SEGMENT_QUERY_TIMEOUT_MS}ms'`);
    const matchingCount = await contactSegmentsRepo.countMatching(req.db, req.clientId, sql, params);
    res.json({ matchingCount });
  } catch (err) {
    if (err.code === '57014') {
      return res.status(503).json({
        error: 'This filter is too broad or complex to preview right now. Try narrowing it — fewer OR conditions, or add a tag/attribute condition to reduce how many contacts need checking.',
      });
    }
    throw err;
  }
}));

module.exports = router;
