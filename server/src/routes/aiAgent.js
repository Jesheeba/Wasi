// Client-facing API for the AI assistant (build-docs/features/ai-agent.md).
// Mounted behind requireClientOrTeamAuth + requireActiveSubscription +
// withTenantContext, so req.db is the RLS-restricted connection.
//
// Roles: consent, the API key and switching the agent on are Owner/Admin only
// (a third-party data-processing decision for the business, SPEC 11.2,
// decision 17). Settings, knowledge and activity are Admin/Manager.
const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const aiAgentRepo = require('../repositories/aiAgentRepo');
const { encrypt } = require('../utils/encryption');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid } = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');
const config = require('../services/aiAgent/config');
const model = require('../services/aiAgent/model');
const prompt = require('../services/aiAgent/prompt');
const knowledge = require('../services/aiAgent/knowledge');
const agentService = require('../services/aiAgent/agentService');

const router = Router();
const ownerOrAdmin = requireRole('Admin');
const manage = requireRole('Admin', 'Manager');

// Draft wording pending legal review (same caveat as the privacy policy).
// Stored verbatim with every consent event; never duplicated inline.
const CONSENT_VERSION = '2026-11-23-draft';
const CONSENT_STATEMENT = 'I agree that, when the AI assistant is switched on, the text of customer messages '
  + 'to this WhatsApp number, the recent conversation and the business information I provide are sent to '
  + 'Anthropic (the AI provider) to generate replies. Phone numbers and contact names are not sent. '
  + 'I can switch the assistant off and withdraw this consent at any time.';

const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
const settingsSchema = z.object({
  mode: z.enum(['shadow', 'live']).optional(),
  model: z.enum(model.ALLOWED_MODELS).optional(),
  business_name: z.string().trim().max(120).optional(),
  business_type: z.string().trim().max(120).optional(),
  description: z.string().trim().max(600).optional(),
  areas_served: z.string().trim().max(300).optional(),
  hours: z.string().trim().max(300).optional(),
  languages: z.array(z.string().trim().min(1).max(30)).min(1).max(6).optional(),
  tone: z.enum(['friendly_professional', 'formal', 'casual']).optional(),
  schedule_mode: z.enum(['always', 'outside_hours']).optional(),
  timezone: z.string().trim().max(60).refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown timezone').optional(),
  staff_hours: z.array(z.object({
    days: z.array(z.number().int().min(0).max(6)).min(1),
    start: z.string().regex(timeRe), end: z.string().regex(timeRe),
  }).refine((w) => w.start < w.end, 'start must be before end')).max(14).optional(),
  fallback_message: z.string().trim().min(1).max(500).optional(),
  handover_message: z.string().trim().min(1).max(500)
    .refine((m) => !/\b(shortly|soon|in a few minutes)\b/i.test(m), 'Do not promise a time ("shortly", "soon"): the handover may fire when nobody is in (SPEC 15).')
    .optional(),
  monthly_cap: z.number().int().min(0).max(100000).optional(),
}).strict();

async function loadAgent(req) {
  const { rows } = await req.db.query('select name from clients where id = $1', [req.clientId]);
  return aiAgentRepo.ensure(req.db, req.clientId, rows[0]?.name);
}

// Coexistence clients answer from their own phone, which Wasi cannot see
// until smb_message_echoes is subscribed and an echo has arrived (SPEC 10.5,
// decision 23). For them "always on" would talk over the owner, so it is
// refused server-side; unknown counts as Coexistence. Read on the privileged
// pool because wasi_app's column grant on wabas does not cover this column.
async function coexistenceBlocksAlways(clientId) {
  const { pool } = require('../db/pool');
  const { rows } = await pool.query(
    `select
       exists (select 1 from wabas where client_id = $1 and coalesce(registration_is_on_biz_app, true)) as coexistence,
       exists (select 1 from messages where client_id = $1 and source = 'whatsapp_app') as echo_seen`,
    [clientId]
  );
  return rows[0].coexistence && !rows[0].echo_seen;
}

async function view(req, agent) {
  const keySource = agent.has_own_key ? 'own' : (config.platformKeyAllowed(req.clientId) ? 'platform' : null);
  return {
    ...agent,
    key_source: keySource,
    in_pilot: config.pilotIncludesClient(req.clientId),
    always_blocked_reason: (await coexistenceBlocksAlways(req.clientId))
      ? 'This number uses the WhatsApp Business app. Replies you send from your phone are not visible to the assistant yet, so it can only run outside your staff hours.'
      : null,
    consent: { version: CONSENT_VERSION, statement: CONSENT_STATEMENT },
    knowledge_budget: knowledge.TOKEN_BUDGET,
    models: model.ALLOWED_MODELS,
  };
}

router.get('/', manage, asyncHandler(async (req, res) => {
  res.json(await view(req, await loadAgent(req)));
}));

router.put('/', manage, asyncHandler(async (req, res) => {
  const data = settingsSchema.parse(req.body);
  await loadAgent(req);
  if (data.schedule_mode === 'always' && await coexistenceBlocksAlways(req.clientId)) {
    return res.status(400).json({ error: 'This number uses the WhatsApp Business app, so the assistant can only run outside staff hours (replies from your phone are not visible to it yet).' });
  }
  res.json(await view(req, await aiAgentRepo.updateSettings(req.db, req.clientId, data)));
}));

router.post('/consent', ownerOrAdmin, asyncHandler(async (req, res) => {
  const { granted } = z.object({ granted: z.boolean() }).strict().parse(req.body);
  const agent = await loadAgent(req);
  await aiAgentRepo.recordConsent(req.db, req.clientId, agent.id, granted, {
    version: CONSENT_VERSION, text: CONSENT_STATEMENT,
    actorType: req.actorType, actorId: req.actorType === 'team_member' ? req.actorId : null,
  });
  res.json(await view(req, await aiAgentRepo.findByClientId(req.db, req.clientId)));
}));

// Validated by a free token-count call before it is stored; only the last 4
// characters ever leave the server again.
router.put('/api-key', ownerOrAdmin, asyncHandler(async (req, res) => {
  const { apiKey } = z.object({ apiKey: z.string().trim().min(20).max(300) }).strict().parse(req.body);
  const agent = await loadAgent(req);
  try {
    await model.countTokens({ apiKey, model: agent.model, text: 'key check' });
  } catch (err) {
    return res.status(400).json({ error: `The key was not accepted by Anthropic (${model.describeError(err)}).` });
  }
  await aiAgentRepo.setKey(req.db, req.clientId, encrypt(apiKey), apiKey.slice(-4));
  res.json(await view(req, await aiAgentRepo.findByClientId(req.db, req.clientId)));
}));

router.delete('/api-key', ownerOrAdmin, asyncHandler(async (req, res) => {
  await loadAgent(req);
  await aiAgentRepo.setKey(req.db, req.clientId, null, null);
  res.json(await view(req, await aiAgentRepo.findByClientId(req.db, req.clientId)));
}));

router.post('/enable', ownerOrAdmin, asyncHandler(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
  const agent = await loadAgent(req);
  if (enabled) {
    const problems = [];
    if (!config.pilotIncludesClient(req.clientId)) problems.push('The AI assistant is in a limited pilot and is not yet available for this account.');
    if (!agent.ai_consent_at) problems.push('Agree to the data-processing statement first.');
    if (!(await agentService.resolveApiKey(req.db, req.clientId))) problems.push('Add your Anthropic API key first.');
    if (!agent.business_name) problems.push('Add your business name.');
    if (agent.schedule_mode === 'outside_hours' && !(agent.staff_hours || []).length) problems.push('Set your staff hours (the assistant only replies outside them).');
    if (problems.length) return res.status(400).json({ error: problems.join(' '), details: problems });
  }
  const actorId = req.actorType === 'team_member' ? req.actorId : null;
  res.json(await view(req, await aiAgentRepo.setEnabled(req.db, req.clientId, enabled, req.actorType, actorId)));
}));

// ---- knowledge
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('qa'), question: z.string().trim().min(1).max(500), answer: z.string().trim().min(1).max(2000), origin: z.enum(['manual', 'history_seed']).optional() }).strict(),
  z.object({ kind: z.enum(['pasted', 'upload']), title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(20000), file_name: z.string().max(200).optional(), file_bytes: z.number().int().optional() }).strict(),
]);
const sourcePatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(), question: z.string().trim().min(1).max(500).optional(),
  answer: z.string().trim().min(1).max(2000).optional(), body: z.string().trim().min(1).max(20000).optional(),
  is_active: z.boolean().optional(),
}).strict();

// Counts with the API when a key is available (decision 20), else estimates.
async function countKnowledgeTokens(req, agent, md) {
  if (!md) return 0;
  const apiKey = await agentService.resolveApiKey(req.db, req.clientId);
  if (apiKey) {
    try { return await model.countTokens({ apiKey, model: agent.model, text: md }); } catch (_) { /* fall back */ }
  }
  return knowledge.estimateTokens(md);
}

// Compiles the would-be knowledge first and refuses a change that breaks the
// budget, so nothing is written for a rejected save (SPEC 8.1).
async function applyKnowledgeChange(req, res, agent, prospective, write) {
  const { md } = knowledge.compile(prospective);
  const tokens = await countKnowledgeTokens(req, agent, md);
  if (tokens > knowledge.TOKEN_BUDGET) {
    return res.status(400).json({ error: `That would make the assistant's knowledge ${tokens} tokens; the limit is ${knowledge.TOKEN_BUDGET}. Shorten it or switch off a source.` });
  }
  const result = await write();
  await aiAgentRepo.setKnowledge(req.db, req.clientId, md, tokens);
  return res.status(result.status || 200).json({ ...result.body, knowledge_tokens: tokens });
}

router.get('/knowledge', manage, asyncHandler(async (req, res) => {
  const agent = await loadAgent(req);
  res.json({ sources: await aiAgentRepo.listSources(req.db, req.clientId), knowledge_tokens: agent.knowledge_tokens, budget: knowledge.TOKEN_BUDGET });
}));

router.post('/knowledge', manage, asyncHandler(async (req, res) => {
  const data = sourceSchema.parse(req.body);
  const agent = await loadAgent(req);
  const existing = await aiAgentRepo.listSources(req.db, req.clientId);
  const draft = { ...data, id: 'new', is_active: true, sort_order: existing.length };
  await applyKnowledgeChange(req, res, agent, [...existing, draft], async () => ({
    status: 201, body: { source: await aiAgentRepo.createSource(req.db, req.clientId, agent.id, { ...data, token_estimate: knowledge.estimateTokens(data.answer || data.body) }) },
  }));
}));

router.patch('/knowledge/:id', manage, asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = sourcePatchSchema.parse(req.body);
  const agent = await loadAgent(req);
  const existing = await aiAgentRepo.listSources(req.db, req.clientId);
  if (!existing.some((s) => s.id === req.params.id)) return res.status(404).json({ error: 'Not found' });
  const prospective = existing.map((s) => (s.id === req.params.id ? { ...s, ...data } : s));
  await applyKnowledgeChange(req, res, agent, prospective, async () => ({
    body: { source: await aiAgentRepo.updateSource(req.db, req.clientId, req.params.id, data) },
  }));
}));

router.delete('/knowledge/:id', manage, asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const agent = await loadAgent(req);
  const existing = await aiAgentRepo.listSources(req.db, req.clientId);
  if (!existing.some((s) => s.id === req.params.id)) return res.status(404).json({ error: 'Not found' });
  await applyKnowledgeChange(req, res, agent, existing.filter((s) => s.id !== req.params.id), async () => {
    await aiAgentRepo.deleteSource(req.db, req.clientId, req.params.id);
    return { body: { deleted: true } };
  });
}));

// Drafts only; nothing is saved until the client accepts one (POST /knowledge).
router.post('/knowledge/suggest', manage, asyncHandler(async (req, res) => {
  const { rows } = await req.db.query(
    `select chat_id, direction, body from messages
     where client_id = $1 and sent_at > now() - interval '60 days' and body is not null and direction in ('in', 'out')
     order by chat_id, sent_at limit 20000`,
    [req.clientId]
  );
  res.json({ suggestions: knowledge.suggestFromHistory(rows) });
}));

// ---- try it (the owner's own test text; no customer data, nothing sent)
const testLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, keyGenerator: (req) => req.clientId, standardHeaders: true, legacyHeaders: false });
router.post('/test', manage, testLimiter, asyncHandler(async (req, res) => {
  const { message } = z.object({ message: z.string().trim().min(1).max(500) }).strict().parse(req.body);
  const agent = await loadAgent(req);
  const apiKey = await agentService.resolveApiKey(req.db, req.clientId);
  if (!apiKey) return res.status(400).json({ error: 'Add your Anthropic API key first.' });
  if (!agent.knowledge_md.trim()) return res.json({ reply: agent.fallback_message, refused: true, reason: 'no_knowledge', cost_paise: 0 });
  const { system, messages } = prompt.buildPrompt(agent, [{ direction: 'in', body: message }]);
  try {
    const r = await model.callModel({ apiKey, model: agent.model, system, messages });
    const refused = prompt.isRefusal(r.text);
    res.json({ reply: refused ? agent.handover_message : r.text, refused, cost_paise: r.costPaise, latency_ms: r.latencyMs, tokens_in: r.tokensIn, tokens_out: r.tokensOut });
  } catch (err) {
    res.status(502).json({ error: `The AI provider did not answer (${model.describeError(err)}).` });
  }
}));

// ---- activity (SPEC 12.4) and the inbox's per-chat notes
router.get('/activity', manage, asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  // Sequential: req.db is one connection, which cannot run queries in parallel.
  const summary = await aiAgentRepo.activitySummary(req.db, req.clientId, days);
  const gates = await aiAgentRepo.gateCounts(req.db, req.clientId, days);
  const recent = await aiAgentRepo.recentReplies(req.db, req.clientId, { limit: 50, handoversOnly: req.query.handovers === '1' });
  res.json({ days, summary, gates, recent });
}));

router.get('/chats/:chatId', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.chatId);
  res.json(await aiAgentRepo.latestForChat(req.db, req.clientId, req.params.chatId));
}));

module.exports = router;
module.exports.CONSENT_STATEMENT = CONSENT_STATEMENT;
