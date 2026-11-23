// Storage for the AI agent (migration 102). Every function takes `db` first:
// req.db (RLS-restricted) from routes, the privileged pool from the runner,
// so every query scopes by client_id explicitly either way.
const PUBLIC_COLUMNS = `id, client_id, is_enabled, enabled_at, mode, model, api_key_last4,
  (api_key_encrypted is not null) as has_own_key, business_name, business_type, description,
  areas_served, hours, languages, tone, schedule_mode, timezone, staff_hours, fallback_message,
  handover_message, knowledge_md, knowledge_tokens, monthly_cap, replies_used, period_start,
  cap_notified_at, ai_consent_at, created_at, updated_at`;

// The settings a client may change through PUT /api/ai-agent (validated by
// the route's schema). Enablement, consent and the key have their own paths.
const EDITABLE = ['mode', 'model', 'business_name', 'business_type', 'description', 'areas_served', 'hours',
  'languages', 'tone', 'schedule_mode', 'timezone', 'staff_hours', 'fallback_message', 'handover_message', 'monthly_cap'];

async function findByClientId(db, clientId) {
  const { rows } = await db.query(`select ${PUBLIC_COLUMNS} from ai_agents where client_id = $1`, [clientId]);
  return rows[0] || null;
}

// Only the runner and the key-save path read the ciphertext.
async function findEncryptedKey(db, clientId) {
  const { rows } = await db.query('select api_key_encrypted from ai_agents where client_id = $1', [clientId]);
  return rows[0] ? rows[0].api_key_encrypted : null;
}

async function ensure(db, clientId, businessName) {
  await db.query(
    `insert into ai_agents (client_id, business_name) values ($1, $2) on conflict (client_id) do nothing`,
    [clientId, businessName || '']
  );
  return findByClientId(db, clientId);
}

async function updateSettings(db, clientId, fields) {
  const cols = Object.keys(fields).filter((c) => EDITABLE.includes(c));
  if (!cols.length) return findByClientId(db, clientId);
  const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const values = cols.map((c) => (c === 'staff_hours' ? JSON.stringify(fields[c]) : fields[c]));
  await db.query(`update ai_agents set ${set}, updated_at = now() where client_id = $1`, [clientId, ...values]);
  return findByClientId(db, clientId);
}

async function setEnabled(db, clientId, enabled, actorType, actorId) {
  await db.query(
    `update ai_agents set is_enabled = $2,
       enabled_at = case when $2 then now() else enabled_at end,
       enabled_by_type = case when $2 then $3 else enabled_by_type end,
       enabled_by_id = case when $2 then $4 else enabled_by_id end,
       updated_at = now()
     where client_id = $1`,
    [clientId, enabled, actorType, actorId]
  );
  return findByClientId(db, clientId);
}

async function setKey(db, clientId, encrypted, last4) {
  await db.query(
    'update ai_agents set api_key_encrypted = $2, api_key_last4 = $3, updated_at = now() where client_id = $1',
    [clientId, encrypted, last4]
  );
}

// Granting writes an event and sets ai_consent_at; revoking writes an event,
// clears it and disables the agent. One transaction, the caller's (req.db).
async function recordConsent(db, clientId, agentId, granted, { version, text, actorType, actorId }) {
  await db.query(
    `insert into ai_agent_consent_events (client_id, agent_id, event_type, statement_version, statement_text, actor_type, actor_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [clientId, agentId, granted ? 'granted' : 'revoked', version, text, actorType, actorId]
  );
  await db.query(
    `update ai_agents set ai_consent_at = case when $2 then now() else null end,
       is_enabled = case when $2 then is_enabled else false end, updated_at = now()
     where client_id = $1`,
    [clientId, granted]
  );
}

// ---- knowledge sources
async function listSources(db, clientId) {
  const { rows } = await db.query(
    'select * from ai_knowledge_sources where client_id = $1 order by sort_order, created_at', [clientId]
  );
  return rows;
}
async function createSource(db, clientId, agentId, s) {
  const { rows } = await db.query(
    `insert into ai_knowledge_sources (client_id, agent_id, kind, title, question, answer, body, file_name, file_bytes, origin, token_estimate, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       coalesce((select max(sort_order) + 1 from ai_knowledge_sources where client_id = $1), 0))
     returning *`,
    [clientId, agentId, s.kind, s.title || null, s.question || null, s.answer || null, s.body || null,
      s.file_name || null, s.file_bytes || null, s.origin || 'manual', s.token_estimate || 0]
  );
  return rows[0];
}
async function updateSource(db, clientId, id, s) {
  const { rows } = await db.query(
    `update ai_knowledge_sources set
       title = coalesce($3, title), question = coalesce($4, question), answer = coalesce($5, answer),
       body = coalesce($6, body), is_active = coalesce($7, is_active), token_estimate = coalesce($8, token_estimate),
       updated_at = now()
     where client_id = $1 and id = $2 returning *`,
    [clientId, id, s.title ?? null, s.question ?? null, s.answer ?? null, s.body ?? null, s.is_active ?? null, s.token_estimate ?? null]
  );
  return rows[0] || null;
}
async function deleteSource(db, clientId, id) {
  const { rowCount } = await db.query('delete from ai_knowledge_sources where client_id = $1 and id = $2', [clientId, id]);
  return rowCount > 0;
}
async function setKnowledge(db, clientId, md, tokens) {
  await db.query(
    'update ai_agents set knowledge_md = $2, knowledge_tokens = $3, updated_at = now() where client_id = $1',
    [clientId, md, tokens]
  );
}

// ---- meter
// Reset the monthly counter on first access in a new month (SPEC 12.3).
async function rollPeriod(db, clientId) {
  await db.query(
    `update ai_agents set replies_used = 0, cap_notified_at = null, period_start = date_trunc('month', now())::date
     where client_id = $1 and period_start < date_trunc('month', now())::date`,
    [clientId]
  );
}
async function incrementReplies(db, clientId) {
  await db.query('update ai_agents set replies_used = replies_used + 1 where client_id = $1', [clientId]);
}
// Returns true only the first time in a period (so the client is told once).
async function markCapNotified(db, clientId) {
  const { rowCount } = await db.query(
    'update ai_agents set cap_notified_at = now() where client_id = $1 and cap_notified_at is null', [clientId]
  );
  return rowCount === 1;
}

// ---- replies and gate log
async function replyExistsForInbound(db, clientId, inboundMessageId) {
  const { rows } = await db.query(
    'select 1 from ai_replies where client_id = $1 and inbound_message_id = $2 limit 1', [clientId, inboundMessageId]
  );
  return rows.length > 0;
}
async function countRecentSentInChat(db, clientId, chatId) {
  const { rows } = await db.query(
    `select count(*)::int as n from ai_replies
     where client_id = $1 and conversation_id = $2 and outcome = 'sent' and created_at > now() - interval '1 hour'`,
    [clientId, chatId]
  );
  return rows[0].n;
}
async function insertReply(db, r) {
  const { rows } = await db.query(
    `insert into ai_replies (client_id, agent_id, conversation_id, inbound_message_id, outbound_message_id, mode,
       customer_text, reply_text, outcome, source_ids, model, tokens_in, tokens_cached, tokens_out, cost_paise, latency_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning *`,
    [r.clientId, r.agentId, r.conversationId, r.inboundMessageId, r.outboundMessageId || null, r.mode,
      r.customerText, r.replyText || null, r.outcome, r.sourceIds || [], r.model,
      r.tokensIn || 0, r.tokensCached || 0, r.tokensOut || 0, r.costPaise || 0, r.latencyMs || null]
  );
  return rows[0];
}
async function insertGateLog(db, { clientId, conversationId, inboundMessageId, gate, detail }) {
  await db.query(
    'insert into ai_gate_log (client_id, conversation_id, inbound_message_id, gate, detail) values ($1, $2, $3, $4, $5)',
    [clientId, conversationId, inboundMessageId || null, gate, detail ? JSON.stringify(detail) : null]
  );
}
async function purgeOldGateLog(db) {
  await db.query("delete from ai_gate_log where created_at < now() - interval '30 days'");
}

// ---- activity (SPEC 12.4)
async function activitySummary(db, clientId, days) {
  const { rows } = await db.query(
    `select
       count(*) filter (where outcome = 'sent')::int as answered,
       count(*) filter (where outcome = 'shadow')::int as shadow,
       count(*) filter (where outcome in ('refused_out_of_scope', 'no_knowledge', 'model_error', 'rate_limited'))::int as handed_over,
       count(*) filter (where outcome = 'send_failed')::int as send_failed,
       coalesce(sum(cost_paise), 0)::int as cost_paise,
       coalesce(sum(tokens_in), 0)::int as tokens_in, coalesce(sum(tokens_out), 0)::int as tokens_out
     from ai_replies where client_id = $1 and created_at > now() - make_interval(days => $2)`,
    [clientId, days]
  );
  return rows[0];
}
async function recentReplies(db, clientId, { limit = 50, handoversOnly = false } = {}) {
  const { rows } = await db.query(
    `select r.id, r.conversation_id, r.mode, r.customer_text, r.reply_text, r.outcome, r.cost_paise, r.latency_ms,
       r.created_at, c.name as chat_name,
       coalesce((select array_agg(coalesce(s.title, s.question) order by s.sort_order)
                 from ai_knowledge_sources s where s.id = any(r.source_ids)), '{}') as source_titles
     from ai_replies r join chats c on c.id = r.conversation_id
     where r.client_id = $1 and ($3::boolean is false or r.outcome <> all(array['sent', 'shadow']))
     order by r.created_at desc limit $2`,
    [clientId, limit, handoversOnly]
  );
  return rows;
}
async function gateCounts(db, clientId, days) {
  const { rows } = await db.query(
    `select gate, count(*)::int as n from ai_gate_log
     where client_id = $1 and created_at > now() - make_interval(days => $2) group by gate order by n desc`,
    [clientId, days]
  );
  return rows;
}
// Latest AI event per chat, for the inbox's "why no reply" / "answered from" notes.
async function latestForChat(db, clientId, chatId) {
  // Sequential: db may be a single connection (req.db).
  const { rows: g } = await db.query('select gate, detail, created_at from ai_gate_log where client_id = $1 and conversation_id = $2 order by created_at desc limit 1', [clientId, chatId]);
  const { rows: r } = await db.query(
      `select r.outcome, r.created_at, r.outbound_message_id,
         coalesce((select array_agg(coalesce(s.title, s.question)) from ai_knowledge_sources s where s.id = any(r.source_ids)), '{}') as source_titles
       from ai_replies r where r.client_id = $1 and r.conversation_id = $2 order by r.created_at desc limit 1`,
      [clientId, chatId]
  );
  return { lastGate: g[0] || null, lastReply: r[0] || null };
}

module.exports = {
  findByClientId, findEncryptedKey, ensure, updateSettings, setEnabled, setKey, recordConsent,
  listSources, createSource, updateSource, deleteSource, setKnowledge,
  rollPeriod, incrementReplies, markCapNotified,
  replyExistsForInbound, countRecentSentInChat, insertReply, insertGateLog, purgeOldGateLog,
  activitySummary, recentReplies, gateCounts, latestForChat, EDITABLE,
};
