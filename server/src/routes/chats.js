const { Router } = require('express');
const chatsRepo = require('../repositories/chatsRepo');
const contactsRepo = require('../repositories/contactsRepo');
const teamMembersRepo = require('../repositories/teamMembersRepo');
const chatNotesRepo = require('../repositories/chatNotesRepo');
const chatSlaLogsRepo = require('../repositories/chatSlaLogsRepo');
const messagingService = require('../services/messagingService');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, chatCreateSchema, chatUpdateSchema, chatAssignSchema, chatNoteCreateSchema, messageSendSchema } = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');

const router = Router();

router.get('/', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  // 'me' means "the caller's own actorId" — resolved here, not in the repo,
  // so chatsRepo.list never needs to know what "me" means (PLAN.md item 2).
  // For an owner (actorType 'owner'), actorId is the client's own id, which
  // will never match a real assigned_team_member_id — that's expected, not
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

// contact_id routes through findOrCreateByContact — a blind create() here
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
// the plan's own matrix — an Agent may claim a chat for themselves, but
// only Admin/Manager may hand it to someone else — is data-dependent, so it
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

  // PLAN.md item 5 — resolution-latency tracking, same non-fatal pattern as
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

// PLAN.md item 3 — internal-only notes, never sent to the customer, never
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
  // written — same discipline as /:id/assign validating teamMemberId,
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
  // note to — author stays null for them, resolved client-side/UI as "you".
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
// Cloud API call, sent/failed bookkeeping) — this is not a DB-only insert.
router.post('/:id/messages', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  if (!chat.phone) return res.status(400).json({ error: 'This chat has no phone number to send to.' });

  const data = messageSendSchema.parse(req.body);
  try {
    // Releases the tenant DB connection before the Meta call and reacquires
    // one only for the result write — see messagingService.sendChatMessage's
    // connectionHooks comment. Without this, the pool's one connection for
    // this request sits idle-in-transaction for the whole Meta round trip.
    const message = await messagingService.sendChatMessage(req.db, req.clientId, chat, data, {
      release: req.commitAndRelease,
      reacquire: req.reacquireDb,
    });

    // SLA first-response tracking (PLAN.md item 5) must never fail the send
    // itself — the WhatsApp message has already gone out by this point; a
    // lost analytics row is an acceptable trade-off, a spurious 500 on a
    // real successful send (risking a caller retry / double-send) is not.
    // Same non-fatal-logging pattern as templateLibrary.js's usage
    // recording. Only ever attributes a team_member/owner reply — never
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
      return res.status(status).json({ error: err.message, code: err.code });
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

  try {
    const updated = await messagingService.retryMessage(req.db, req.clientId, chat, message, {
      release: req.commitAndRelease,
      reacquire: req.reacquireDb,
    });
    res.json(updated);
  } catch (err) {
    if (err instanceof messagingService.MessagingError) {
      const status = err.code === 'send_failed' ? 502 : 409;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}));

module.exports = router;
