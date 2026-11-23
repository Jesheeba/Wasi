// AI agent Phase 1 (build-docs/features/ai-agent.md). Test names start with
// the acceptance criterion (AC) or SPEC 16.1 row they cover.
//
// Real Postgres (TEST_DATABASE_URL), disposable __test_suite__ clients deleted
// in after(). Nothing reaches Anthropic or Meta: model.callModel/countTokens
// and messagingService.sendChatMessage are stubbed on their module objects.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const authTokensRepo = require('../src/repositories/authTokensRepo');
const chatsRepo = require('../src/repositories/chatsRepo');
const messagingService = require('../src/services/messagingService');
const model = require('../src/services/aiAgent/model');
const gates = require('../src/services/aiAgent/gates');
const prompt = require('../src/services/aiAgent/prompt');
const knowledge = require('../src/services/aiAgent/knowledge');
const agentService = require('../src/services/aiAgent/agentService');
const { createAiAgentRunner } = require('../src/services/aiAgentRunner');

const SUITE = '__test_suite__aiagent_';
const PASSWORD = 'test-suite-password-12345';
const PHONE = '9092766740';
const stamp = Date.now();
let server, base, token, clientId, otherToken, otherClientId;
const teamMemberIds = [];

const api = (path, opts = {}, t = token) => fetch(`${base}${path}`, {
  ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, ...(opts.headers || {}) },
});
const json = async (path, opts, t) => { const r = await api(path, opts, t); return { status: r.status, body: await r.json().catch(() => null) }; };

async function register(email, name) {
  await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ businessName: name, email, password: PASSWORD }) });
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) }).then((r) => r.json());
  const { rows } = await pool.query('select id from clients where email = $1', [email]);
  return { token: login.token, id: rows[0].id };
}

async function teamMemberToken(role) {
  const created = await json('/api/team-members', { method: 'POST', body: JSON.stringify({ name: `${SUITE}${role}`, email: `${SUITE}${role}-${Date.now()}@wasi.local`, role }) });
  teamMemberIds.push(created.body.id);
  const invite = await authTokensRepo.create('team_member', created.body.id, 'team_invite', 60);
  const res = await fetch(`${base}/api/auth/team/accept-invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invite, password: PASSWORD }) });
  return (await res.json()).token;
}

// A chat with one inbound message, as the webhook would leave it.
async function makeConversation({ phone = PHONE, body = 'What are the fees?', inboundAgoMs = 60 * 1000 } = {}) {
  const contact = (await pool.query('insert into contacts (client_id, name, phone) values ($1, $2, $3) on conflict (client_id, phone) do update set name = excluded.name returning id', [clientId, `${SUITE}contact`, `91${phone}`])).rows[0];
  const at = new Date(Date.now() - inboundAgoMs);
  const chat = (await pool.query('insert into chats (client_id, name, contact_id, last_inbound_at) values ($1, $2, $3, $4) returning *', [clientId, `${SUITE}chat`, contact.id, at])).rows[0];
  const msg = (await pool.query("insert into messages (client_id, chat_id, direction, body, sent_at) values ($1, $2, 'in', $3, $4) returning id", [clientId, chat.id, body, at])).rows[0];
  const job = { id: 'job', client_id: clientId, conversation_id: chat.id, inbound_message_id: msg.id, created_at: new Date() };
  return { chat, msg, job };
}

// Stubs (installed per test, restored in beforeEach).
const originals = { callModel: model.callModel, countTokens: model.countTokens, send: messagingService.sendChatMessage };
let sends; let modelCalls;
function stubModel(text = 'The course fee is Rs 12,000.') {
  model.callModel = async (args) => {
    modelCalls.push(args);
    if (text instanceof Error) throw text;
    return { text, stopReason: 'end_turn', tokensIn: 900, tokensCached: 0, tokensOut: 30, costPaise: model.costPaise('claude-haiku-4-5', 900, 30), latencyMs: 12 };
  };
}
function stubSend({ fail = false } = {}) {
  messagingService.sendChatMessage = async (db, cId, chat, m) => {
    if (fail) throw Object.assign(new Error('stub send failure'), { code: 'send_failed' });
    sends.push(m.body);
    return (await db.query("insert into messages (client_id, chat_id, direction, body, status, sent_at) values ($1, $2, 'out', $3, 'sent', now()) returning *", [cId, chat.id, m.body])).rows[0];
  };
}

async function setAgent(fields) {
  const cols = Object.keys(fields);
  await pool.query(`update ai_agents set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where client_id = $1`,
    [clientId, ...cols.map((c) => (c === 'staff_hours' ? JSON.stringify(fields[c]) : fields[c]))]);
}
const reply = async (chatId) => (await pool.query('select * from ai_replies where conversation_id = $1 order by created_at desc limit 1', [chatId])).rows[0];
const lastGate = async (chatId) => (await pool.query('select gate from ai_gate_log where conversation_id = $1 order by id desc limit 1', [chatId])).rows[0]?.gate;
const chatRow = async (id) => (await pool.query('select * from chats where id = $1', [id])).rows[0];

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  ({ token, id: clientId } = await register(`test-suite-aiagent-${stamp}@wasi.local`, `${SUITE}client`));
  ({ token: otherToken, id: otherClientId } = await register(`test-suite-aiagent-other-${stamp}@wasi.local`, `${SUITE}other`));
  process.env.AI_LIVE_ALLOWLIST = `${clientId}:${PHONE}`;
  process.env.AI_PLATFORM_KEY_CLIENT_IDS = '';
});

beforeEach(() => {
  model.callModel = originals.callModel; model.countTokens = originals.countTokens; messagingService.sendChatMessage = originals.send;
  sends = []; modelCalls = [];
  model.countTokens = async ({ text }) => knowledge.estimateTokens(text);
});

after(async () => {
  model.callModel = originals.callModel; model.countTokens = originals.countTokens; messagingService.sendChatMessage = originals.send;
  await new Promise((r) => server.close(r));
  await pool.query('delete from auth_tokens where subject_id = any($1::uuid[])', [teamMemberIds]).catch(() => {});
  await pool.query('delete from clients where id = any($1::uuid[])', [[clientId, otherClientId]]);
  await pool.end();
});

// ------------------------------------------------------------- pure units
const now = new Date('2026-11-23T08:00:00Z'); // 13:30 IST, a Monday
const baseAgent = { client_id: 'c1', is_enabled: true, ai_consent_at: now, schedule_mode: 'always', timezone: 'Asia/Kolkata', staff_hours: null, replies_used: 0, monthly_cap: 10 };
const baseChat = { ai_muted: false, ai_cooldown_until: null, last_inbound_at: new Date(now - 60000), assigned_team_member_id: null, last_agent_reply_at: null };
const decide = (o = {}) => {
  process.env.AI_LIVE_ALLOWLIST = 'c1:9092766740';
  const r = gates.decide({ agent: { ...baseAgent, ...o.agent }, client: { status: 'active', ...o.client }, chat: { ...baseChat, ...o.chat }, contactPhone: o.phone || '919092766740', hasKey: o.hasKey ?? true, recentRepliesInChat: o.recent || 0, now });
  process.env.AI_LIVE_ALLOWLIST = `${clientId}:${PHONE}`;
  return r;
};

test('16.1 gates: SPEC table, one row each', () => {
  assert.equal(decide({ agent: { is_enabled: false } }).gate, 'agent_off', 'agent disabled');
  assert.equal(decide({ agent: { is_enabled: false } }).log, false, 'off is not logged');
  assert.equal(decide({ agent: { ai_consent_at: null } }).gate, 'agent_off', 'enabled without consent');
  assert.equal(decide({ client: { status: 'suspended' } }).gate, 'agent_off', 'suspended client');
  assert.equal(decide({ hasKey: false }).gate, 'no_api_key');
  assert.equal(decide({ phone: '919999999999' }).gate, 'not_in_pilot', 'any other number');
  assert.equal(decide({ chat: { ai_muted: true } }).gate, 'muted');
  assert.equal(decide({ chat: { ai_cooldown_until: new Date(now.getTime() + 60000) } }).gate, 'cooldown');
  assert.equal(decide({ chat: { ai_cooldown_until: new Date(now.getTime() - 60000) } }).pass, true, 'expired cooldown');
  const closed = decide({ chat: { last_inbound_at: new Date(now.getTime() - (24 * 3600 + 60) * 1000) } });
  assert.equal(closed.gate, 'window_closed'); assert.ok(closed.handover, 'window closed flags the chat');
  assert.equal(decide({ chat: { last_inbound_at: new Date(now.getTime() - (24 * 3600 - 60) * 1000) } }).pass, true, '23h59m proceeds');
  assert.equal(decide({ chat: { last_inbound_at: null } }).gate, 'window_closed', 'unknown window = closed');
  assert.equal(decide({ chat: { assigned_team_member_id: 'tm' } }).gate, 'human_active');
  assert.equal(decide({ chat: { last_agent_reply_at: new Date(now.getTime() - 14 * 60000) } }).gate, 'human_active', 'replied 14 min ago');
  assert.equal(decide({ chat: { last_agent_reply_at: new Date(now.getTime() - 16 * 60000) } }).pass, true, 'replied 16 min ago');
  assert.equal(decide({ agent: { replies_used: 10 } }).gate, 'cap_reached');
  assert.equal(decide({ recent: 4 }).gate, 'rate_limited', '5th reply in an hour hands over');
  assert.equal(decide({}).pass, true);
});

test('16.1 gates: schedule - inside staff hours is silent outside_hours mode; muted and cooldown are independent', () => {
  const weekday = [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '18:00' }];
  assert.equal(decide({ agent: { schedule_mode: 'outside_hours', staff_hours: weekday } }).gate, 'outside_schedule', '13:30 IST Monday');
  assert.equal(decide({ agent: { schedule_mode: 'outside_hours', staff_hours: [{ days: [0], start: '09:00', end: '18:00' }] } }).pass, true, 'Sunday-only staff');
  assert.equal(gates.withinStaffHours([{ days: [1], start: '13:00', end: '14:00' }], 'Asia/Kolkata', now), true);
  assert.equal(gates.withinStaffHours([{ days: [1], start: '13:00', end: '14:00' }], 'UTC', now), false, 'timezone is honoured');
  assert.equal(decide({ chat: { ai_muted: true, ai_cooldown_until: null } }).gate, 'muted');
  assert.equal(decide({ chat: { ai_muted: false, ai_cooldown_until: new Date(now.getTime() + 1) } }).gate, 'cooldown');
});

test('prompt: rules first, no phone or name, user turn first, refusal anywhere in the reply', () => {
  const p = prompt.buildPrompt({ business_name: 'Acme', knowledge_md: 'Fee: Rs 100', languages: ['english', 'tamil'], tone: 'formal' },
    [{ direction: 'out', body: 'Hello' }, { direction: 'in', body: 'x'.repeat(900) }, { direction: 'out', body: 'ok' }, { direction: 'in', body: 'fees?' }]);
  assert.equal(p.system[0].text, prompt.RULES);
  assert.match(p.system[1].text, /Fee: Rs 100/);
  assert.equal(p.messages[0].role, 'user', 'leading assistant turn dropped');
  assert.equal(p.messages[0].content.length, 500, 'turns truncated to 500 chars');
  assert.doesNotMatch(JSON.stringify(p), new RegExp(PHONE));
  assert.equal(prompt.isRefusal('NEEDS_HUMAN'), true);
  assert.equal(prompt.isRefusal('Sorry. NEEDS_HUMAN because...'), true);
  assert.equal(prompt.isRefusal(''), true, 'empty reply is never sent');
  assert.equal(prompt.isRefusal('The fee is Rs 100.'), false);
});

test('model: cost in integer paise; no sampling parameters are sent', async () => {
  assert.equal(model.costPaise('claude-haiku-4-5', 3000, 150), Math.round(((3000 * 1 + 150 * 5) / 1e6) * 88 * 100));
  assert.ok(Number.isInteger(model.costPaise('claude-haiku-5-5', 12345, 67)));
  assert.doesNotMatch(require('fs').readFileSync(require.resolve('../src/services/aiAgent/model.js'), 'utf8').replace(/\/\/.*$/gm, ''), /temperature\s*:/, 'API 2026-10-21 rejects temperature');
});

test('knowledge: compile skips inactive sources; history seeder drafts repeated questions with the reply staff gave', () => {
  const { md, sourceIds } = knowledge.compile([
    { id: 'a', kind: 'qa', question: 'Fees?', answer: 'Rs 100', is_active: true, sort_order: 0 },
    { id: 'b', kind: 'pasted', title: 'Timings', body: '9 to 5', is_active: true, sort_order: 1 },
    { id: 'c', kind: 'qa', question: 'Old?', answer: 'gone', is_active: false, sort_order: 2 },
  ]);
  assert.match(md, /\*\*Q: Fees\?\*\*\nA: Rs 100/); assert.match(md, /## Timings\n9 to 5/); assert.doesNotMatch(md, /gone/);
  assert.deepEqual(sourceIds, ['a', 'b']);
  const rows = [];
  for (let i = 0; i < 4; i += 1) rows.push({ chat_id: `c${i}`, direction: 'in', body: 'What is the fee for the batch?' }, { chat_id: `c${i}`, direction: 'out', body: 'The fee is Rs 12,000.' });
  rows.push({ chat_id: 'z', direction: 'in', body: 'hi' }, { chat_id: 'z', direction: 'out', body: 'hello' });
  const s = knowledge.suggestFromHistory(rows);
  assert.equal(s.length, 1); assert.equal(s[0].answer, 'The fee is Rs 12,000.'); assert.equal(s[0].asked, 4);
});

// ------------------------------------------------------------- API
test('AC9 + roles: settings, consent (Owner/Admin only), key encrypted and never returned', async () => {
  const get = await json('/api/ai-agent');
  assert.equal(get.status, 200);
  assert.equal(get.body.is_enabled, false); assert.equal(get.body.mode, 'shadow'); assert.equal(get.body.in_pilot, true);
  assert.equal(get.body.schedule_mode, 'outside_hours', 'safe default');

  const managerToken = await teamMemberToken('Manager');
  assert.equal((await json('/api/ai-agent/consent', { method: 'POST', body: JSON.stringify({ granted: true }) }, managerToken)).status, 403, 'Manager cannot consent');
  assert.equal((await json('/api/ai-agent', {}, await teamMemberToken('Agent'))).status, 403, 'Agent cannot read settings');

  const consent = await json('/api/ai-agent/consent', { method: 'POST', body: JSON.stringify({ granted: true }) });
  assert.ok(consent.body.ai_consent_at);
  const ev = (await pool.query('select * from ai_agent_consent_events where client_id = $1', [clientId])).rows;
  assert.equal(ev.length, 1); assert.equal(ev[0].actor_type, 'owner'); assert.match(ev[0].statement_text, /Anthropic/);

  model.countTokens = async ({ apiKey }) => { if (apiKey.includes('bad')) throw Object.assign(new Error('x'), { status: 401 }); return 3; };
  assert.equal((await json('/api/ai-agent/api-key', { method: 'PUT', body: JSON.stringify({ apiKey: 'sk-ant-bad-0000000000000000' }) })).status, 400, 'rejected key not stored');
  const saved = await json('/api/ai-agent/api-key', { method: 'PUT', body: JSON.stringify({ apiKey: 'sk-ant-test-secret-KEY-1234' }) });
  assert.equal(saved.status, 200); assert.equal(saved.body.api_key_last4, '1234'); assert.equal(saved.body.key_source, 'own');
  assert.doesNotMatch(JSON.stringify(saved.body), /secret-KEY/, 'key never returned');
  const stored = (await pool.query('select api_key_encrypted from ai_agents where client_id = $1', [clientId])).rows[0].api_key_encrypted;
  assert.doesNotMatch(stored, /secret-KEY/, 'encrypted at rest');
  assert.equal(await agentService.resolveApiKey(pool, clientId), 'sk-ant-test-secret-KEY-1234');
});

test('AC8: enabling is refused outside the pilot and without staff hours; settings validate honest handover wording', async () => {
  const other = await json('/api/ai-agent/enable', { method: 'POST', body: JSON.stringify({ enabled: true }) }, otherToken);
  assert.equal(other.status, 400); assert.match(other.body.error, /limited pilot/);
  const noHours = await json('/api/ai-agent/enable', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  assert.equal(noHours.status, 400); assert.match(noHours.body.error, /staff hours/);
  assert.equal((await json('/api/ai-agent', { method: 'PUT', body: JSON.stringify({ handover_message: 'Someone will reply shortly!' }) })).status, 400);
  assert.equal((await json('/api/ai-agent', { method: 'PUT', body: JSON.stringify({ staff_hours: [{ days: [1], start: '18:00', end: '09:00' }] }) })).status, 400);
  const ok = await json('/api/ai-agent', { method: 'PUT', body: JSON.stringify({ business_name: 'Acme Coaching', staff_hours: [{ days: [0], start: '00:00', end: '00:01' }], monthly_cap: 5 }) });
  assert.equal(ok.status, 200);
  const on = await json('/api/ai-agent/enable', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  assert.equal(on.status, 200); assert.equal(on.body.is_enabled, true);
});

test('knowledge: CRUD recompiles; over-budget change is refused and nothing is written; suggest returns drafts only', async () => {
  const a = await json('/api/ai-agent/knowledge', { method: 'POST', body: JSON.stringify({ kind: 'qa', question: 'What are the fees?', answer: 'The course fee is Rs 12,000.' }) });
  assert.equal(a.status, 201);
  let agent = (await pool.query('select knowledge_md, knowledge_tokens from ai_agents where client_id = $1', [clientId])).rows[0];
  assert.match(agent.knowledge_md, /Rs 12,000/); assert.ok(agent.knowledge_tokens > 0);
  const big = await json('/api/ai-agent/knowledge', { method: 'POST', body: JSON.stringify({ kind: 'pasted', title: 'Brochure', body: 'x '.repeat(5000) }) });
  assert.equal(big.status, 400); assert.match(big.body.error, /limit is 2500/);
  assert.equal((await json('/api/ai-agent/knowledge')).body.sources.length, 1, 'rejected source not saved');
  const off = await json(`/api/ai-agent/knowledge/${a.body.source.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: false }) });
  assert.equal(off.status, 200);
  agent = (await pool.query('select knowledge_md from ai_agents where client_id = $1', [clientId])).rows[0];
  assert.equal(agent.knowledge_md, '', 'inactive source leaves the knowledge');
  await json(`/api/ai-agent/knowledge/${a.body.source.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: true }) });
  assert.equal((await json(`/api/ai-agent/knowledge/${a.body.source.id}`, {}, otherToken)).status, 404, 'tenant isolation');
  const sug = await json('/api/ai-agent/knowledge/suggest', { method: 'POST', body: '{}' });
  assert.equal(sug.status, 200); assert.ok(Array.isArray(sug.body.suggestions));
});

test('try-it: answers from knowledge via the model, refusal shows the handover text', async () => {
  stubModel('The course fee is Rs 12,000.');
  const ok = await json('/api/ai-agent/test', { method: 'POST', body: JSON.stringify({ message: 'fees?' }) });
  assert.equal(ok.status, 200); assert.equal(ok.body.reply, 'The course fee is Rs 12,000.'); assert.equal(ok.body.refused, false);
  assert.equal(modelCalls[0].apiKey, 'sk-ant-test-secret-KEY-1234', 'uses the client\'s own key');
  stubModel('NEEDS_HUMAN');
  const no = await json('/api/ai-agent/test', { method: 'POST', body: JSON.stringify({ message: 'capital of Peru?' }) });
  assert.equal(no.body.refused, true); assert.doesNotMatch(no.body.reply, /NEEDS_HUMAN/);
});

// ------------------------------------------------------------- pipeline
test('AC2: answerable question, live mode, allowed number -> sent, metered, logged with sources, marked as AI in the inbox', async () => {
  await setAgent({ mode: 'live', replies_used: 0 });
  stubModel('The course fee is Rs 12,000.'); stubSend();
  const { chat, job } = await makeConversation();
  const out = await agentService.handleJob(job);
  assert.equal(out.outcome, 'sent');
  assert.deepEqual(sends, ['The course fee is Rs 12,000.']);
  const r = await reply(chat.id);
  assert.equal(r.outcome, 'sent'); assert.ok(r.outbound_message_id); assert.equal(r.source_ids.length, 1); assert.ok(r.cost_paise > 0);
  assert.equal((await pool.query('select replies_used from ai_agents where client_id = $1', [clientId])).rows[0].replies_used, 1);
  const msgs = await chatsRepo.listMessages(pool, clientId, chat.id);
  assert.ok(msgs.find((m) => m.direction === 'out').ai_reply_id, 'AI reply is marked for the inbox');
  assert.equal((await chatRow(chat.id)).last_agent_reply_at, null, 'an AI send is never "human activity"');
  assert.equal((await agentService.handleJob(job)).skipped, 'already_handled', 'a retried job never replies twice');
  assert.equal(sends.length, 1);
});

test('AC3: out-of-scope -> handover message, flagged, 2h cooldown, token never sent; ai_muted untouched', async () => {
  stubModel('NEEDS_HUMAN - this is not about the business'); stubSend();
  const { chat, job } = await makeConversation({ body: 'What is the capital of Peru?' });
  assert.equal((await agentService.handleJob(job)).outcome, 'refused_out_of_scope');
  assert.equal(sends.length, 1); assert.doesNotMatch(sends[0], /NEEDS_HUMAN/);
  const c = await chatRow(chat.id);
  assert.ok(c.ai_handover_reason); assert.ok(new Date(c.ai_cooldown_until) > new Date(Date.now() + 110 * 60000)); assert.equal(c.ai_muted, false);
  assert.equal(c.assigned_team_member_id, null, 'left unassigned (no auto-assignment exists)');
});

test('AC4: a human reply from the inbox clears the handover and silences the agent for 15 minutes', async () => {
  stubModel('NEEDS_HUMAN'); stubSend();
  const { chat, job } = await makeConversation();
  await agentService.handleJob(job);
  assert.ok((await chatRow(chat.id)).ai_handover_reason);
  // Production calls this on the request's transaction (it uses a savepoint).
  const tx = await pool.connect();
  try { await tx.query('begin'); assert.equal(await chatsRepo.markAgentReplyNonFatal(tx, clientId, chat.id), true); await tx.query('commit'); } finally { tx.release(); }
  assert.equal((await chatRow(chat.id)).ai_handover_reason, null);
  await pool.query('update chats set ai_cooldown_until = null where id = $1', [chat.id]);
  const msg = (await pool.query("insert into messages (client_id, chat_id, direction, body, sent_at) values ($1, $2, 'in', 'and timings?', now()) returning id", [clientId, chat.id])).rows[0];
  stubModel('Should not be called'); modelCalls = [];
  assert.equal((await agentService.handleJob({ ...job, inbound_message_id: msg.id })).gate, 'human_active');
  assert.equal(modelCalls.length, 0);
});

test('unmuting during a cooldown does not clear the cooldown (two different things)', async () => {
  const { chat } = await makeConversation();
  const until = new Date(Date.now() + 3600000);
  await pool.query('update chats set ai_muted = true, ai_cooldown_until = $2 where id = $1', [chat.id, until]);
  const res = await json(`/api/chats/${chat.id}/ai-mute`, { method: 'POST', body: JSON.stringify({ muted: false }) });
  assert.equal(res.status, 200);
  const c = await chatRow(chat.id);
  assert.equal(c.ai_muted, false); assert.equal(new Date(c.ai_cooldown_until).getTime(), until.getTime());
});

test('model error and send failure: handed over, logged, meter NOT incremented', async () => {
  await setAgent({ replies_used: 0 });
  stubModel(Object.assign(new Error('boom'), { status: 529 })); stubSend();
  const e = await makeConversation();
  assert.equal((await agentService.handleJob(e.job)).outcome, 'model_error');
  assert.ok((await chatRow(e.chat.id)).ai_handover_reason); assert.equal(sends.length, 0);
  stubModel('The fee is Rs 12,000.'); stubSend({ fail: true });
  const f = await makeConversation();
  assert.equal((await agentService.handleJob(f.job)).outcome, 'send_failed');
  assert.equal((await pool.query('select replies_used from ai_agents where client_id = $1', [clientId])).rows[0].replies_used, 0);
});

test('AC8: shadow mode never sends; any number other than the pilot number gets nothing and no model call', async () => {
  await setAgent({ mode: 'shadow' });
  stubModel('The fee is Rs 12,000.'); stubSend();
  const s = await makeConversation();
  assert.equal((await agentService.handleJob(s.job)).outcome, 'shadow');
  assert.equal(sends.length, 0); assert.equal((await reply(s.chat.id)).outcome, 'shadow');
  await setAgent({ mode: 'live' });
  modelCalls = [];
  const o = await makeConversation({ phone: '9876543210' });
  assert.equal((await agentService.handleJob(o.job)).gate, 'not_in_pilot');
  assert.equal(modelCalls.length, 0); assert.equal(sends.length, 0);
  assert.equal(await lastGate(o.chat.id), 'not_in_pilot');
});

test('16.1: window closed, empty knowledge, cap reached (notified once)', async () => {
  stubModel('x'); stubSend();
  const w = await makeConversation({ inboundAgoMs: 25 * 3600 * 1000 });
  assert.equal((await agentService.handleJob(w.job)).gate, 'window_closed');
  assert.ok((await chatRow(w.chat.id)).ai_handover_reason);

  const md = (await pool.query('select knowledge_md from ai_agents where client_id = $1', [clientId])).rows[0].knowledge_md;
  await setAgent({ knowledge_md: '' });
  const k = await makeConversation();
  assert.equal((await agentService.handleJob(k.job)).outcome, 'no_knowledge');
  assert.equal(sends.length, 1, 'fallback message sent'); assert.equal(modelCalls.length, 0);
  await setAgent({ knowledge_md: md });

  await setAgent({ replies_used: 5, monthly_cap: 5, cap_notified_at: null });
  const c1 = await makeConversation(); const c2 = await makeConversation();
  assert.equal((await agentService.handleJob(c1.job)).gate, 'cap_reached');
  const first = (await pool.query('select cap_notified_at from ai_agents where client_id = $1', [clientId])).rows[0].cap_notified_at;
  await agentService.handleJob(c2.job);
  const second = (await pool.query('select cap_notified_at from ai_agents where client_id = $1', [clientId])).rows[0].cap_notified_at;
  assert.ok(first); assert.equal(second.getTime(), first.getTime(), 'notified once');
  await pool.query("update ai_agents set period_start = date_trunc('month', now())::date - interval '1 month' where client_id = $1", [clientId]);
  await agentService.handleJob((await makeConversation()).job);
  assert.equal((await pool.query('select replies_used from ai_agents where client_id = $1', [clientId])).rows[0].replies_used, 1, 'new month resets the meter once');
});

test('AC7: a client without the agent is invisible - nothing is enqueued', async () => {
  const runner = createAiAgentRunner({ isEligible: agentService.isEligible, handler: async () => { throw new Error('must not run'); } });
  const none = await runner.enqueueIfEligible({ clientId: otherClientId, conversationId: '00000000-0000-0000-0000-000000000000', inboundMessageId: '00000000-0000-0000-0000-000000000000', flowOutcome: { handled: false, how: null } });
  assert.equal(none.enqueued, false); assert.equal(none.reason, 'agent_not_available');
  assert.equal(await agentService.isEligible(clientId), true, 'the pilot client with an enabled agent is eligible');
});

test('AC6: activity reconciles with ai_replies', async () => {
  const a = await json('/api/ai-agent/activity?days=30');
  assert.equal(a.status, 200);
  const db = (await pool.query(`select count(*) filter (where outcome = 'sent')::int sent, coalesce(sum(cost_paise),0)::int cost from ai_replies where client_id = $1`, [clientId])).rows[0];
  assert.equal(a.body.summary.answered, db.sent); assert.equal(a.body.summary.cost_paise, db.cost);
  assert.ok(a.body.gates.some((g) => g.gate === 'not_in_pilot'));
  assert.ok(a.body.recent.length > 0);
  const handovers = await json('/api/ai-agent/activity?handovers=1');
  assert.ok(handovers.body.recent.every((r) => !['sent', 'shadow'].includes(r.outcome)));
});

test('revoking consent switches the agent off immediately', async () => {
  const r = await json('/api/ai-agent/consent', { method: 'POST', body: JSON.stringify({ granted: false }) });
  assert.equal(r.body.ai_consent_at, null); assert.equal(r.body.is_enabled, false);
  assert.equal(await agentService.isEligible(clientId), false);
});
