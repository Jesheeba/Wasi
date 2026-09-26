// Instagram DM Automation, Phase 1 — inbox routes (list conversations,
// thread history, reply). Deliberately separate from chats.js, not a
// channel-aware branch inside it — see instagramConnectionService.js's and
// the 081/082 migrations' own comments for why (parallel-tables decision).
const { Router } = require('express');
const instagramAccountsRepo = require('../repositories/instagramAccountsRepo');
const instagramConversationsRepo = require('../repositories/instagramConversationsRepo');
const instagramMessagesRepo = require('../repositories/instagramMessagesRepo');
const instagramClient = require('../utils/instagramClient');
const { decrypt } = require('../utils/encryption');
const { asyncHandler } = require('../utils/asyncHandler');
const { uuid, instagramMessageSendSchema } = require('../utils/validate');
const { requireRole } = require('../middleware/requireRole');

const router = Router();

router.get('/conversations', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  res.json(await instagramConversationsRepo.list(req.db, req.clientId));
}));

router.get('/conversations/:id/messages', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const conversation = await instagramConversationsRepo.findById(req.db, req.clientId, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  res.json(await instagramMessagesRepo.listByConversation(req.db, req.clientId, req.params.id));
}));

router.post('/conversations/:id/mark-read', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const conversation = await instagramConversationsRepo.markRead(req.db, req.clientId, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  res.json(conversation);
}));

// A straightforward send — no consent gate, no plan-limit gate, no
// template/24h-window concept, none of which have an Instagram Messaging
// API analog (see instagramConnectionService.js's own comment on why this
// isn't a retrofit of messagingService.sendChatMessage). Mirrors that
// function's pending-row/mark-sent/mark-failed bookkeeping shape as its own
// parallel function, matching this codebase's established convention of
// sibling functions over polymorphic ones.
//
// KNOWN GAP, recorded not silently missed (see CLAUDE.md Known Gaps):
// Instagram DMs are bound by the same 24-hour standard messaging window as
// Messenger (confirmed against Meta's own policy docs), with a
// `human_agent` tag extending it to 7 days for a genuine manual reply only.
// This route has no window check and no tag parameter at all — a send
// outside the window will be rejected by Meta directly, surfaced via the
// 502/err.metaError below, not pre-empted with a clearer explanation.
router.post('/conversations/:id/messages', requireRole('Admin', 'Manager', 'Agent'), asyncHandler(async (req, res) => {
  uuid.parse(req.params.id);
  const conversation = await instagramConversationsRepo.findById(req.db, req.clientId, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Not found' });

  const { body } = instagramMessageSendSchema.parse(req.body);

  const igAccount = await instagramAccountsRepo.findById(conversation.instagram_account_id);
  if (!igAccount || igAccount.status !== 'connected' || !igAccount.access_token_encrypted) {
    return res.status(400).json({ error: 'No connected Instagram account for this conversation.' });
  }

  const message = await instagramMessagesRepo.insertOutboundPending(req.db, req.clientId, conversation.id, body);

  try {
    const accessToken = decrypt(igAccount.access_token_encrypted);
    const result = await instagramClient.sendInstagramMessage(igAccount.page_id, accessToken, conversation.ig_scoped_id, { text: body });
    const sent = await instagramMessagesRepo.markSent(req.db, req.clientId, message.id, result.message_id || null);
    await instagramConversationsRepo.touchLastMessageAt(req.db, conversation.id, false);
    res.status(201).json(sent);
  } catch (err) {
    await instagramMessagesRepo.markFailed(req.db, req.clientId, message.id, err.message);
    res.status(502).json({ error: 'Instagram message send failed', detail: err.message, metaError: err.metaError || null });
  }
}));

module.exports = router;
