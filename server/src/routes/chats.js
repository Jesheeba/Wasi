const { Router } = require('express');
const chatsRepo = require('../repositories/chatsRepo');
const contactsRepo = require('../repositories/contactsRepo');
const teamMembersRepo = require('../repositories/teamMembersRepo');
const chatNotesRepo = require('../repositories/chatNotesRepo');
const chatSlaLogsRepo = require('../repositories/chatSlaLogsRepo');
const messagingService = require('../services/messagingService');
const whatsappFlowsRepo = require('../repositories/whatsappFlowsRepo');
const flowTemplates = require('../utils/whatsappFlowTemplates');
const wabasRepo = require('../repositories/wabasRepo');
const productMessages = require('../utils/productMessages');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');
const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, chatCreateSchema, chatUpdateSchema, chatAssignSchema, chatNoteCreateSchema, messageSendSchema, reactionSchema } = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');

const router = Router();

router.get('/', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  // 'me' means "the caller's own actorId" - resolved here, not in the repo,
  // so chatsRepo.list never needs to know what "me" means (PLAN.md item 2).
  // For an owner (actorType 'owner'), actorId is the client's own id, which
  // will never match a real assigned_team_member_id - that's expected, not
  // an error: an owner has nothing of their own to filter to, so this
  // returns an empty set rather than throwing.
  const assignedTo = req.query.assignedTo === 'me' ? req.actorId : req.query.assignedTo;
  res.json(await chatsRepo.list(req.db, req.clientId, {
    since: req.query.since,
    status: req.query.status,
    assignedTo,
  }));
}));

router.get('/:id', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  res.json(chat);
}));

// contact_id routes through findOrCreateByContact - a blind create() here
// would insert a second chat row for a contact who already has one (the
// "New Conversation" flow in app.js calls this every time a contact is
// picked, not just once, so this dedup is load-bearing, not defensive).
// The contact is re-fetched server-side rather than trusting the client's
// copy of name/phone/tag_id, which could be stale.
router.post('/', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  const data = chatCreateSchema.parse(req.body);
  if (data.contact_id) {
    const contact = await contactsRepo.findById(req.db, req.clientId, data.contact_id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const chat = await chatsRepo.findOrCreateByContact(req.db, req.clientId, contact);
    return res.status(201).json(chat);
  }
  const chat = await chatsRepo.create(req.db, req.clientId, data);
  res.status(201).json(chat);
}));

router.patch('/:id', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = chatUpdateSchema.parse(req.body);
  const chat = await chatsRepo.update(req.db, req.clientId, req.params.id, data);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  res.json(chat);
}));

router.delete('/:id', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const deleted = await chatsRepo.remove(req.db, req.clientId, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

// PLAN.md item 2. requireRole gates the router-wide floor (Agent can reach
// this route at all); the finer "self vs. someone else" distinction from
// the plan's own matrix - an Agent may claim a chat for themselves, but
// only Admin/Manager may hand it to someone else - is data-dependent, so it
// lives here as an explicit in-route check, not something requireRole's
// static allow-list can express.
router.post('/:id/assign', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const { teamMemberId } = chatAssignSchema.parse(req.body);

  if (req.actorRole === 'Agent' && teamMemberId !== req.actorId) {
    return res.status(403).json({ error: 'Agents can only assign a chat to themselves.' });
  }

  const teamMember = await teamMembersRepo.findById(req.db, req.clientId, teamMemberId);
  if (!teamMember) return res.status(400).json({ error: 'teamMemberId does not belong to this client.' });

  const chat = await chatsRepo.update(req.db, req.clientId, req.params.id, { assigned_team_member_id: teamMemberId });
  if (!chat) return res.status(404).json({ error: 'Not found' });
  res.json(chat);
}));

router.post('/:id/unassign', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const existing = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  // Same self-vs-someone-else split as assign above: an Agent may release a
  // chat only currently assigned to themselves.
  if (req.actorRole === 'Agent' && existing.assigned_team_member_id !== req.actorId) {
    return res.status(403).json({ error: 'Agents can only unassign a chat currently assigned to themselves.' });
  }

  const chat = await chatsRepo.update(req.db, req.clientId, req.params.id, { assigned_team_member_id: null });
  res.json(chat);
}));

router.post('/:id/resolve', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const chat = await chatsRepo.update(req.db, req.clientId, req.params.id, { status: 'resolved' });
  if (!chat) return res.status(404).json({ error: 'Not found' });

  // PLAN.md item 5 - resolution-latency tracking, same non-fatal pattern as
  // the send handler above: resolving the chat is the real action, a lost
  // SLA row is an acceptable trade-off, a spurious 500 here is not.
  try {
    const teamMemberId = req.actorType === 'team_member' ? req.actorId : null;
    const lastInbound = await chatsRepo.findLastInboundMessage(req.db, req.clientId, chat.id);
    await chatSlaLogsRepo.recordResolution(req.db, req.clientId, chat.id, teamMemberId, lastInbound);
  } catch (err) {
    console.error('chatSlaLogsRepo: recordResolution failed (non-fatal):', err.message);
    await chatSlaLogsRepo.alertOnWriteFailure(err);
  }

  res.json(chat);
}));

router.post('/:id/reopen', requireRole('Admin', 'Manager'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const chat = await chatsRepo.update(req.db, req.clientId, req.params.id, { status: 'open' });
  if (!chat) return res.status(404).json({ error: 'Not found' });
  res.json(chat);
}));

// PLAN.md item 3 - internal-only notes, never sent to the customer, never
// mixed into GET /:id/messages (a completely separate table, no relation
// to `messages`).
router.get('/:id/notes', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  res.json(await chatNotesRepo.list(req.db, req.clientId, req.params.id));
}));

router.post('/:id/notes', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  const { body, mentions } = chatNoteCreateSchema.parse(req.body);

  // Every mentioned id must actually belong to this client before it's
  // written - same discipline as /:id/assign validating teamMemberId,
  // since mentioned_team_member_ids can't carry a real FK constraint
  // (Postgres has no FK-on-array-element).
  if (mentions && mentions.length > 0) {
    const { rows } = await req.db.query(
      'select id from team_members where client_id = $1 and id = any($2::uuid[])',
      [req.clientId, mentions]
    );
    const validIds = new Set(rows.map((r) => r.id));
    const invalid = mentions.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      return res.status(400).json({ error: 'mentions contains an id that does not belong to this client', invalid });
    }
  }

  // The owner (actorType 'owner') has no team_members row to attribute a
  // note to - author stays null for them, resolved client-side/UI as "you".
  const authorTeamMemberId = req.actorType === 'team_member' ? req.actorId : null;
  const note = await chatNotesRepo.create(req.db, req.clientId, req.params.id, { authorTeamMemberId, body, mentions });
  res.status(201).json(note);
}));

router.get('/:id/messages', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  res.json(await chatsRepo.listMessages(req.db, req.clientId, req.params.id, { since: req.query.since }));
}));

// Real send: goes through messagingService (session-window check, Meta
// Cloud API call, sent/failed bookkeeping) - this is not a DB-only insert.
router.post('/:id/messages', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  if (!chat.phone) return res.status(400).json({ error: 'This chat has no phone number to send to.' });

  const data = messageSendSchema.parse(req.body);
  // A person is replying from the inbox: gate 4's human-active signal
  // (migration 087). This route and the retry route below are the ONLY
  // places in the server that write it from a Wasi send; it must never move
  // into messagingService, which flows/broadcasts/the Hub API share.
  await chatsRepo.markAgentReplyNonFatal(req.db, req.clientId, chat.id);
  try {
    // Releases the tenant DB connection before the Meta call and reacquires
    // one only for the result write - see messagingService.sendChatMessage's
    // connectionHooks comment. Without this, the pool's one connection for
    // this request sits idle-in-transaction for the whole Meta round trip.
    const message = await messagingService.sendChatMessage(req.db, req.clientId, chat, data, {
      release: req.commitAndRelease,
      reacquire: req.reacquireDb,
    });

    // SLA first-response tracking (PLAN.md item 5) must never fail the send
    // itself - the WhatsApp message has already gone out by this point; a
    // lost analytics row is an acceptable trade-off, a spurious 500 on a
    // real successful send (risking a caller retry / double-send) is not.
    // Same non-fatal-logging pattern as templateLibrary.js's usage
    // recording. Only ever attributes a team_member/owner reply - never
    // automation/broadcast/Hub API, since requireRole above already
    // guarantees req.actorType is always 'team_member' or 'owner' here.
    try {
      const teamMemberId = req.actorType === 'team_member' ? req.actorId : null;
      const lastInbound = await chatsRepo.findLastInboundMessage(req.db, req.clientId, chat.id);
      await chatSlaLogsRepo.recordFirstResponseIfAbsent(req.db, req.clientId, chat.id, teamMemberId, lastInbound);
    } catch (err) {
      console.error('chatSlaLogsRepo: recordFirstResponseIfAbsent failed (non-fatal):', err.message);
      await chatSlaLogsRepo.alertOnWriteFailure(err);
    }

    res.status(201).json(message);
  } catch (err) {
    if (err instanceof messagingService.MessagingError) {
      const status = err.code === 'send_failed' ? 502 : 409;
      // metaErrorCode (Meta's raw numeric code, when this failure came from
      // a real Graph API rejection - see messagingService.js's own
      // err.metaError comment) lets the client translate this into the same
      // plain English the sendability banner uses (server/src/utils/
      // sendabilityMessages.js) instead of showing Meta's raw string.
      return res.status(status).json({ error: err.message, code: err.code, metaErrorCode: err.metaError?.code ?? null });
    }
    throw err;
  }
}));

// Emoji reaction (2026-11-23) - emoji '' removes a previously-sent
// reaction (Meta's own documented convention). Deliberately not gated by
// markAgentReplyNonFatal the way a real reply is above - reacting isn't a
// substitute for a person actually answering the customer, so it shouldn't
// silence the AI agent's gate-4 human-active signal the way a real send
// does (docs/ai-agent/SPEC.md's own distinction, applied here even though
// the agent isn't built yet, so this doesn't need revisiting later).
router.post('/:id/messages/:messageId/react', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  uuid.parse(req.params.messageId);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  if (!chat.phone) return res.status(400).json({ error: 'This chat has no phone number to send to.' });

  const { emoji } = reactionSchema.parse(req.body);
  try {
    const message = await messagingService.sendReactionToMessage(req.db, req.clientId, chat, req.params.messageId, emoji);
    res.json(message);
  } catch (err) {
    if (err instanceof messagingService.MessagingError) {
      const status = err.code === 'send_failed' ? 502 : err.code === 'message_not_found' ? 404 : 409;
      return res.status(status).json({ error: err.message, code: err.code, metaErrorCode: err.metaError?.code ?? null });
    }
    throw err;
  }
}));

// --- WhatsApp quick wins: read ticks, typing, block
// (build-docs/features/whatsapp-quick-wins.md) ---
async function chatWaba(clientId) {
  const waba = await wabasRepo.findByClientId(clientId);
  if (!waba || waba.status !== 'connected' || !waba.access_token_encrypted) return null;
  return { waba, token: decrypt(waba.access_token_encrypted) };
}

async function newestInboundMetaId(db, clientId, chatId) {
  const { rows } = await db.query(
    `select meta_message_id from messages
     where client_id = $1 and chat_id = $2 and direction = 'in' and meta_message_id is not null
     order by sent_at desc limit 1`,
    [clientId, chatId]
  );
  return rows[0]?.meta_message_id || null;
}

// Best effort: a failure here must never get in the way of the inbox, so
// the answer is always 200 with { sent, reason }.
async function readOrTyping(req, res, typing) {
  uuid.parse(req.params.id);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  const messageId = await newestInboundMetaId(req.db, req.clientId, chat.id);
  if (!messageId) return res.json({ sent: false, reason: 'no_inbound_message' });
  const conn = await chatWaba(req.clientId);
  if (!conn) return res.json({ sent: false, reason: 'waba_not_connected' });
  try {
    await metaClient.markReadAndTyping(conn.waba.phone_number_id, conn.token, messageId, { typing });
    return res.json({ sent: true });
  } catch (err) {
    return res.json({ sent: false, reason: err.message });
  }
}
router.post('/:id/read', requireRole('Admin', 'Manager', 'Agent'), asyncHandler((req, res) => readOrTyping(req, res, false)));
router.post('/:id/typing', requireRole('Admin', 'Manager', 'Agent'), asyncHandler((req, res) => readOrTyping(req, res, true)));

async function blockOrUnblock(req, res, unblock) {
  uuid.parse(req.params.id);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  if (!chat.phone) return res.status(400).json({ error: 'This chat has no phone number.' });
  const conn = await chatWaba(req.clientId);
  if (!conn) return res.status(409).json({ error: 'Connect your WhatsApp number first.' });
  let result;
  try {
    result = await metaClient.setBlockedUsers(conn.waba.phone_number_id, conn.token, [chat.phone], { unblock });
  } catch (err) {
    return res.status(502).json({ error: unblock ? 'WhatsApp did not unblock this contact' : 'WhatsApp did not block this contact', detail: err.message });
  }
  if (!result.done.length) {
    const e = result.failed[0]?.errors?.[0];
    const detail = e?.code === 131047
      ? 'WhatsApp only allows blocking someone who messaged you in the last 24 hours.'
      : (e?.error_data?.details || e?.message || 'WhatsApp did not accept the request.');
    return res.status(409).json({ error: detail, metaErrorCode: e?.code ?? null });
  }
  if (chat.contact_id) {
    await req.db.query(
      'update contacts set whatsapp_blocked_at = $3 where client_id = $1 and id = $2',
      [req.clientId, chat.contact_id, unblock ? null : new Date().toISOString()]
    );
  }
  res.json({ blocked: !unblock });
}
router.get('/:id/block', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const { rows } = await req.db.query(
    `select co.whatsapp_blocked_at from chats ch left join contacts co on co.id = ch.contact_id
     where ch.client_id = $1 and ch.id = $2`,
    [req.clientId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ blocked: Boolean(rows[0].whatsapp_blocked_at) });
}));
router.post('/:id/block', requireRole('Admin', 'Manager'), asyncHandler((req, res) => blockOrUnblock(req, res, false)));
router.delete('/:id/block', requireRole('Admin', 'Manager'), asyncHandler((req, res) => blockOrUnblock(req, res, true)));

// Send catalog products (build-docs/features/catalog-product-messages.md).
// Here, not in routes/ecommerce.js, for the same reason as /forms below: a
// person sending from the inbox is a human reply (markAgentReplyNonFatal).
router.post('/:id/products', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  if (!chat.phone) return res.status(400).json({ error: 'This chat has no phone number to send to.' });
  const waba = await wabasRepo.findByClientId(req.clientId);
  const built = productMessages.buildProductInteractive(req.body || {}, waba?.commerce_catalog_id);
  if (built.error) return res.status(400).json({ error: built.error });
  await chatsRepo.markAgentReplyNonFatal(req.db, req.clientId, chat.id);
  try {
    const message = await messagingService.sendChatMessage(req.db, req.clientId, chat, {
      type: 'product', body: String(req.body.body || '').trim(), product: built,
    }, { release: req.commitAndRelease, reacquire: req.reacquireDb });
    res.status(201).json(message);
  } catch (err) {
    if (err instanceof messagingService.MessagingError) {
      const status = err.code === 'send_failed' ? 502 : 409;
      return res.status(status).json({ error: err.message, code: err.code, metaErrorCode: err.metaError?.code ?? null });
    }
    throw err;
  }
}));

// Send a WhatsApp Form (build-docs/features/whatsapp-flows.md) into this
// chat. Lives here, not in routes/whatsappFlows.js, because a person sending
// a form from the inbox is a human reply and markAgentReplyNonFatal may only
// be called from this file (test/chatsLastAgentReplyAt.test.js). Drafts go
// out in Meta's draft mode (with its "draft" banner) so a form can be tried
// before it is published.
const formSendSchema = z.object({
  flowId: z.string().uuid(),
  body: z.string().trim().min(1).max(1024),
  cta: z.string().trim().min(1).max(30).refine((v) => !/\p{Extended_Pictographic}/u.test(v), 'Button text cannot contain emoji'),
});
router.post('/:id/forms', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  if (!chat.phone) return res.status(400).json({ error: 'This chat has no phone number to send to.' });
  const data = formSendSchema.parse(req.body);
  const flow = await whatsappFlowsRepo.findById(req.db, req.clientId, data.flowId);
  if (!flow) return res.status(404).json({ error: 'Form not found' });
  if (!flow.meta_flow_id || !['draft', 'published'].includes(flow.status)) {
    return res.status(409).json({ error: "This form can't be sent: WhatsApp never accepted it, or it has been retired." });
  }
  await chatsRepo.markAgentReplyNonFatal(req.db, req.clientId, chat.id);
  try {
    const message = await messagingService.sendChatMessage(req.db, req.clientId, chat, {
      type: 'flow', body: data.body,
      flow: {
        // Live forms (endpoint kinds) carry the chat in the token so a booking
        // knows who made it, and open with data_exchange (endpoint INIT).
        name: flow.name, metaFlowId: flow.meta_flow_id,
        flowToken: flowTemplates.makeFlowToken(flow.id, flowTemplates.KINDS[flow.kind].endpoint ? chat.id : undefined),
        action: flowTemplates.KINDS[flow.kind].endpoint ? 'data_exchange' : 'navigate',
        cta: data.cta, screen: flowTemplates.KINDS[flow.kind].screen, mode: flow.status === 'draft' ? 'draft' : 'published',
      },
    }, { release: req.commitAndRelease, reacquire: req.reacquireDb });
    res.status(201).json(message);
  } catch (err) {
    if (err instanceof messagingService.MessagingError) {
      const status = err.code === 'send_failed' ? 502 : 409;
      return res.status(status).json({ error: err.message, code: err.code, metaErrorCode: err.metaError?.code ?? null });
    }
    throw err;
  }
}));

router.post('/:id/messages/:messageId/retry', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  uuid.parse(req.params.messageId);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  const message = await chatsRepo.findMessageById(req.db, req.clientId, req.params.id, req.params.messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });

  // A person retrying a failed message is working this chat (see the send
  // route above). One of the two permitted writers of last_agent_reply_at.
  await chatsRepo.markAgentReplyNonFatal(req.db, req.clientId, chat.id);
  try {
    const updated = await messagingService.retryMessage(req.db, req.clientId, chat, message, {
      release: req.commitAndRelease,
      reacquire: req.reacquireDb,
    });
    res.json(updated);
  } catch (err) {
    if (err instanceof messagingService.MessagingError) {
      const status = err.code === 'send_failed' ? 502 : 409;
      return res.status(status).json({ error: err.message, code: err.code, metaErrorCode: err.metaError?.code ?? null });
    }
    throw err;
  }
}));

module.exports = router;
