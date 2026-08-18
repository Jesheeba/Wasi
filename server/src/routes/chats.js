const { Router } = require('express');
const chatsRepo = require('../repositories/chatsRepo');
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

router.post('/', asyncHandler(async (req, res) => {
  const data = chatCreateSchema.parse(req.body);
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
    const message = await messagingService.sendChatMessage(req.db, req.clientId, chat, data);
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
    const updated = await messagingService.retryMessage(req.db, req.clientId, chat, message);
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
