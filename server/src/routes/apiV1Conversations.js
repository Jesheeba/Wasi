// Hub API read endpoints (build plan Phase 5's MCP tool inventory) —
// list_conversations / get_conversation_history. Same requireApiKey +
// privileged `pool` shape as apiV1Messages.js/apiV1Templates.js: this is a
// server-to-server caller, not a tenant-authenticated browser session, so
// there's no req.db/withTenantContext here either — see
// middleware/requireApiKey.js's module comment for why.
//
// Pagination is applied in JS after the existing repo call rather than a
// new LIMIT-aware SQL query — chatsRepo.list/listMessages already return
// everything for a client, and Hub API callers are developer/agent tools,
// not this app's own chat UI, so the extra rows fetched here are not a hot
// path. `limit` bounds what actually reaches the caller (and, for an MCP
// tool, what lands in the calling model's context) — kept deliberately
// small by default (see plan doc §11 "avoid a single tool call returning an
// unbounded amount of data into the model's context").
const { Router } = require('express');
const { pool } = require('../db/pool');
const { z } = require('zod');
const chatsRepo = require('../repositories/chatsRepo');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid } = require('../utils/validate');
const { requireApiKey } = require('../middleware/requireApiKey');
const { sendApiError } = require('../utils/apiError');

const router = Router();
router.use(requireApiKey);

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

router.get('/', asyncHandler(async (req, res) => {
  const { limit } = listQuerySchema.parse(req.query);
  const chats = await chatsRepo.list(pool, req.clientId);
  res.json(chats.slice(0, limit));
}));

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Returns the most recent `limit` messages, oldest-first (conversation
// reading order) — chatsRepo.listMessages is already ascending by sent_at,
// so slicing from the end keeps that order while trimming to the tail.
router.get('/:id/messages', asyncHandler(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { limit } = historyQuerySchema.parse(req.query);
  const chat = await chatsRepo.findById(pool, req.clientId, id);
  if (!chat) return sendApiError(res, 404, 'conversation_not_found', 'Not found.');
  const messages = await chatsRepo.listMessages(pool, req.clientId, id);
  res.json(messages.slice(-limit));
}));

module.exports = router;
