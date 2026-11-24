// The AI agent pipeline (SPEC section 7): the handler the aiAgentRunner runs
// for each ai_jobs row, plus the eligibility check the webhook uses before
// enqueueing. Runs on the privileged pool, so every query scopes by client.
//
// The handler does not throw for expected outcomes (gates, refusals, model or
// send failures): those are recorded and the job is done. It throws only for
// infrastructure failures, which the runner retries; the idempotency check
// below makes a retry after a successful send a no-op, never a double reply.
const aiAgentRepo = require('../../repositories/aiAgentRepo');
const messagingService = require('../messagingService');
const { decrypt } = require('../../utils/encryption');
const config = require('./config');
const gates = require('./gates');
const prompt = require('./prompt');
const model = require('./model');
const knowledge = require('./knowledge');

const getPool = () => require('../../db/pool').pool;

// Own key first; the platform key only for clients allowed to use it.
async function resolveApiKey(db, clientId) {
  const encrypted = await aiAgentRepo.findEncryptedKey(db, clientId);
  if (encrypted) return decrypt(encrypted);
  return config.platformKeyAllowed(clientId) ? process.env.ANTHROPIC_API_KEY : null;
}

// Used by enqueueIfEligible: cheap, no model call, nothing enqueued for a
// client without an enabled, consented agent inside the pilot. This is what
// keeps the feature invisible when off (SPEC 16.3 point 8).
async function isEligible(clientId) {
  if (!config.pilotIncludesClient(clientId)) return false;
  const agent = await aiAgentRepo.findByClientId(getPool(), clientId);
  return Boolean(agent && agent.is_enabled && agent.ai_consent_at);
}

async function loadContext(db, job) {
  const { rows } = await db.query(
    `select c.*, ct.phone as contact_phone, cl.status as client_status
     from chats c join clients cl on cl.id = c.client_id left join contacts ct on ct.id = c.contact_id
     where c.client_id = $1 and c.id = $2`,
    [job.client_id, job.conversation_id]
  );
  const chat = rows[0];
  const { rows: inbound } = await db.query(
    'select id, body, sent_at from messages where client_id = $1 and id = $2', [job.client_id, job.inbound_message_id]
  );
  return { chat, inbound: inbound[0] };
}

async function recentHistory(db, clientId, chatId, upTo) {
  const { rows } = await db.query(
    `select direction, body from messages
     where client_id = $1 and chat_id = $2 and sent_at <= $3 and direction in ('in', 'out')
     order by sent_at desc limit 12`,
    [clientId, chatId, upTo]
  );
  return rows.reverse();
}

async function flagForHuman(db, clientId, chatId, reason, { cooldown = false } = {}) {
  await db.query(
    `update chats set ai_handover_reason = $3, ai_handover_at = now(),
       ai_cooldown_until = case when $4 then now() + interval '2 hours' else ai_cooldown_until end
     where client_id = $1 and id = $2`,
    [clientId, chatId, reason, cooldown]
  );
}

// Sends through the normal path (24h check, plan limit, logging inherited).
// Returns the outbound message row, or null if sending failed.
async function send(db, clientId, chat, body) {
  try {
    return await messagingService.sendChatMessage(db, clientId, chat, { type: 'text', body });
  } catch (err) {
    console.error('aiAgent: send failed:', { clientId, chatId: chat.id, error: err.message, code: err.code });
    return null;
  }
}

async function handleJob(job, { db = getPool(), now = () => new Date() } = {}) {
  const clientId = job.client_id;
  if (await aiAgentRepo.replyExistsForInbound(db, clientId, job.inbound_message_id)) return { skipped: 'already_handled' };

  await aiAgentRepo.rollPeriod(db, clientId);
  const agent = await aiAgentRepo.findByClientId(db, clientId);
  const { chat, inbound } = await loadContext(db, job);
  if (!chat || !inbound) return { skipped: 'missing_chat_or_message' };

  const apiKey = agent ? await resolveApiKey(db, clientId) : null;
  const log = (gate, detail) => aiAgentRepo.insertGateLog(db, {
    clientId, conversationId: chat.id, inboundMessageId: inbound.id, gate, detail,
  });

  const decision = gates.decide({
    agent, client: { status: chat.client_status }, chat, contactPhone: chat.contact_phone, hasKey: Boolean(apiKey),
    recentRepliesInChat: agent ? await aiAgentRepo.countRecentSentInChat(db, clientId, chat.id) : 0, now: now(),
  });
  if (!decision.pass) {
    if (decision.log) await log(decision.gate, decision.detail);
    if (decision.handover) await flagForHuman(db, clientId, chat.id, decision.handover);
    if (decision.gate === 'cap_reached' && await aiAgentRepo.markCapNotified(db, clientId)) {
      console.warn('aiAgent: monthly cap reached', { clientId });
    }
    return { gate: decision.gate };
  }

  const live = agent.mode === 'live';
  const base = { clientId, agentId: agent.id, conversationId: chat.id, inboundMessageId: inbound.id,
    mode: agent.mode, customerText: inbound.body || '', model: agent.model };

  // Gate 7 - nothing to answer from.
  if (!knowledge.getKnowledgeFor(agent).trim()) {
    const sent = live ? await send(db, clientId, chat, agent.fallback_message) : null;
    await flagForHuman(db, clientId, chat.id, 'No knowledge configured for the assistant');
    await aiAgentRepo.insertReply(db, { ...base, outcome: 'no_knowledge', replyText: agent.fallback_message, outboundMessageId: sent?.id });
    return { outcome: 'no_knowledge' };
  }

  const sources = (await aiAgentRepo.listSources(db, clientId)).filter((s) => s.is_active);
  const { system, messages } = prompt.buildPrompt(agent, await recentHistory(db, clientId, chat.id, inbound.sent_at));
  let result;
  try {
    result = await model.callModel({ apiKey, model: agent.model, system, messages });
  } catch (err) {
    const reason = model.describeError(err);
    console.error('aiAgent: model call failed:', { clientId, reason, status: err.status });
    await flagForHuman(db, clientId, chat.id, `AI error (${reason})`);
    await aiAgentRepo.insertReply(db, { ...base, outcome: 'model_error', replyText: reason });
    return { outcome: 'model_error', reason };
  }
  const usage = { tokensIn: result.tokensIn, tokensCached: result.tokensCached, tokensOut: result.tokensOut,
    costPaise: result.costPaise, latencyMs: result.latencyMs, sourceIds: sources.map((s) => s.id) };

  // Gate 8 - the model said it can't answer from what it was told.
  if (prompt.isRefusal(result.text)) {
    const sent = live ? await send(db, clientId, chat, agent.handover_message) : null;
    await flagForHuman(db, clientId, chat.id, 'Question outside what the assistant was told', { cooldown: true });
    await aiAgentRepo.insertReply(db, { ...base, ...usage, outcome: 'refused_out_of_scope', replyText: result.text, outboundMessageId: sent?.id });
    return { outcome: 'refused_out_of_scope' };
  }

  if (!live) {
    await aiAgentRepo.insertReply(db, { ...base, ...usage, outcome: 'shadow', replyText: result.text });
    return { outcome: 'shadow' };
  }
  const sent = await send(db, clientId, chat, result.text);
  if (!sent) {
    // Tokens spent, nothing delivered: needs attention, not just a log line (SPEC 13).
    await flagForHuman(db, clientId, chat.id, 'AI reply could not be sent');
    await aiAgentRepo.insertReply(db, { ...base, ...usage, outcome: 'send_failed', replyText: result.text });
    return { outcome: 'send_failed' };
  }
  await aiAgentRepo.incrementReplies(db, clientId); // only after a successful send
  await aiAgentRepo.insertReply(db, { ...base, ...usage, outcome: 'sent', replyText: result.text, outboundMessageId: sent.id });
  return { outcome: 'sent' };
}

module.exports = { handleJob, isEligible, resolveApiKey };
