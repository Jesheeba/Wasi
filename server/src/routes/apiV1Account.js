// Hub API read endpoints (build plan Phase 5's MCP tool inventory) —
// get_account_status / get_rate_limit_status. Same requireApiKey +
// privileged `pool` shape as the rest of the Hub API. Never returns
// access_token_encrypted or any other secret column — only the fields an
// MCP client needs to self-diagnose "why did my send fail" (connection
// status, quality rating) per the plan doc's §3 rationale.
//
// `client_id` is included here specifically so the MCP server
// (mcp-server/src/hubClient.js) can resolve it once, from the API key
// alone, and inject it automatically into every POST /api/v1/messages call
// — apiMessageSendSchema requires a client_id body field as a
// defense-in-depth check (see validate.js's comment), but that's an
// internal identifier no MCP tool caller (a model, or the person prompting
// it) has any reason to already know. Exposing it here keeps every tool's
// schema task-shaped, not plumbing-shaped.
const { Router } = require('express');
const wabasRepo = require('../repositories/wabasRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireApiKey } = require('../middleware/requireApiKey');

const router = Router();
router.use(requireApiKey);

router.get('/', asyncHandler(async (req, res) => {
  const waba = await wabasRepo.findByClientId(req.clientId);
  if (!waba) {
    return res.json({ client_id: req.clientId, connected: false, status: 'not_connected' });
  }
  res.json({
    client_id: req.clientId,
    connected: waba.status === 'connected',
    status: waba.status,
    display_name: waba.display_name || null,
    phone_number_id: waba.phone_number_id || null,
    quality_rating: waba.quality_rating || null,
    verified_at: waba.verified_at || null,
  });
}));

// Static ceiling only, not live per-key usage — middleware/rateLimit.js's
// apiLimiter store is in-memory/per-process and isn't queryable, and this
// project deliberately doesn't stand up new usage-tracking infrastructure
// just for this v1 tool (see wasi-mcp-server-plan.md's open decisions).
// Still useful to a calling model as a hard number to pace bursts against.
router.get('/rate-limit', asyncHandler(async (req, res) => {
  res.json({
    limit_per_minute: 300,
    window_seconds: 60,
    scope: 'per API key, shared across every Hub API endpoint',
    note: 'This is the account-wide ceiling, not live usage — usage isn\'t tracked per-key yet. Pace bursts (e.g. broadcast-style sends) comfortably under this number rather than relying on hitting a 429 to find the edge.',
  });
}));

module.exports = router;
