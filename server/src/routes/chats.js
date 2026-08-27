const { Router } = require('express');
const chatsRepo = require('../repositories/chatsRepo');
const contactsRepo = require('../repositories/contactsRepo');
const messagingService = require('../services/messagingService');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, chatCreateSchema, chatUpdateSchema, messageSendSchema } = require('../utils/validate');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await chatsRepo.list(req.db, req.clientId, { since: req.query.since }));
}));

router.get('/:id', asyncHandler(async (req, res) => {
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
router.post('/', asyncHandler(async (req, res) => {
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

router.patch('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const data = chatUpdateSchema.parse(req.body);
  const chat = await chatsRepo.update(req.db, req.clientId, req.params.id, data);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  res.json(chat);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const deleted = await chatsRepo.remove(req.db, req.clientId, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
}));

router.get('/:id/messages', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  res.json(await chatsRepo.listMessages(req.db, req.clientId, req.params.id, { since: req.query.since }));
}));

// Real send: goes through messagingService (session-window check, Meta
// Cloud API call, sent/failed bookkeeping) — this is not a DB-only insert.
router.post('/:id/messages', asyncHandler(async (req, res) => {
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
    res.status(201).json(message);
  } catch (err) {
    if (err instanceof messagingService.MessagingError) {
      const status = err.code === 'send_failed' ? 502 : 409;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}));

router.post('/:id/messages/:messageId/retry', asyncHandler(async (req, res) => {
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
