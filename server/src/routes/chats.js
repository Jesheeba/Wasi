const { Router } = require('express');
const chatsRepo = require('../repositories/chatsRepo');
const contactsRepo = require('../repositories/contactsRepo');
const teamMembersRepo = require('../repositories/teamMembersRepo');
const messagingService = require('../services/messagingService');
const metaClient = require('../utils/metaClient');
const { decrypt } = require('../utils/encryption');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, chatCreateSchema, chatUpdateSchema, chatAssignSchema, messageSendSchema } = require('../utils/validate');

// GAP_FIX_PLAN.md Phase E1 — how long to wait on each of the two Meta
// round trips (resolve the media URL, then fetch the bytes) before giving
// up. Matches mediaHeaderService.resolveMediaIdFromUrl's existing
// 15s convention for a comparable "fetch a file over the network" call.
const MEDIA_FETCH_TIMEOUT_MS = 15000;

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

// GAP_FIX_PLAN.md Phase E2 — attribution only: this just labels who's
// handling a conversation for everyone sharing the one client login, it's
// not an authorization/visibility check (no per-agent login exists yet).
router.patch('/:id/assign', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const { team_member_id } = chatAssignSchema.parse(req.body);
  const chat = await chatsRepo.findById(req.db, req.clientId, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });

  if (team_member_id) {
    const member = await teamMembersRepo.findById(req.db, req.clientId, team_member_id);
    if (!member) return res.status(404).json({ error: 'Team member not found' });
  }

  const updated = await chatsRepo.assign(req.db, req.clientId, req.params.id, team_member_id);
  res.json(updated);
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

// Proxies a customer's inbound media (image/audio/video/document/sticker)
// back through this server rather than returning Meta's own media URL
// directly to the browser — that URL is short-lived (5 minutes, see
// metaClient.getMediaUrl) and requires the WABA's bearer token to fetch,
// which the browser never has and shouldn't. This app deliberately doesn't
// store the file itself (see migration 034_inbound_media.js) — every
// request re-resolves and re-fetches from Meta, which also means a
// message whose media has aged out on Meta's side degrades to a clear
// error here rather than ever having worked and then silently breaking.
router.get('/:id/messages/:messageId/media', asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  uuid.parse(req.params.messageId);
  const message = await chatsRepo.findMessageById(req.db, req.clientId, req.params.id, req.params.messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (!message.media_id) return res.status(404).json({ error: 'This message has no media attached' });

  let waba;
  try {
    waba = await messagingService.getSendableWaba(req.clientId);
  } catch (err) {
    if (err instanceof messagingService.MessagingError) {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  try {
    const accessToken = await decrypt(waba.access_token_encrypted);
    const { url } = await metaClient.getMediaUrl(message.media_id, accessToken, MEDIA_FETCH_TIMEOUT_MS);
    const { buffer, mimeType } = await metaClient.downloadMediaBytes(url, accessToken, MEDIA_FETCH_TIMEOUT_MS);
    res.setHeader('Content-Type', message.media_mime_type || mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (message.media_filename) {
      res.setHeader('Content-Disposition', `inline; filename="${message.media_filename.replace(/"/g, '')}"`);
    }
    res.send(buffer);
  } catch (err) {
    res.status(502).json({
      error: 'Could not fetch this media from Meta',
      detail: `${err.message} — the media may have expired on Meta's side (their retention window for inbound media is not officially documented).`,
    });
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
