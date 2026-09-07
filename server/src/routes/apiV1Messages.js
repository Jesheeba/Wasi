// Hub send API (build plan Phase 5) — lets other Sirah applications send
// through Wasi's Meta connection without holding a Meta token themselves.
// Runs entirely on the privileged `pool` connection (see
// middleware/requireApiKey.js's module comment) and reuses
// messagingService.sendChatMessage exactly as chats.js's internal send
// route does — the plan-limit, 24-hour-window, and Phase 4 opt-in checks
// all live inside that one function, so calling it here is what makes this
// endpoint subject to the same guards as the CRM UI, not a second copy of
// them that could drift out of sync.
const { Router } = require('express');
const { pool } = require('../db/pool');
const contactsRepo = require('../repositories/contactsRepo');
const chatsRepo = require('../repositories/chatsRepo');
const messageTemplatesRepo = require('../repositories/messageTemplatesRepo');
const messagingService = require('../services/messagingService');
const metaClient = require('../utils/metaClient');
const { asyncHandler } = require('../utils/asyncHandler');
const { apiMessageSendSchema, uuid } = require('../utils/validate');
const { requireApiKey } = require('../middleware/requireApiKey');
const { sendApiError } = require('../utils/apiError');

const router = Router();
router.use(requireApiKey);

// get_message_status (MCP tool inventory) — id is this app's own message
// row id, returned as `id` in the POST / response below, not Meta's
// message id. Scoped to the caller's own client_id via
// chatsRepo.findMessageByIdForClient regardless of which chat it landed in.
router.get('/:id/status', asyncHandler(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const message = await chatsRepo.findMessageByIdForClient(pool, req.clientId, id);
  if (!message) return sendApiError(res, 404, 'message_not_found', 'Not found.');
  res.json({
    id: message.id,
    chat_id: message.chat_id,
    direction: message.direction,
    status: message.status,
    error_reason: message.error_reason,
    meta_error_code: message.meta_error_code,
    meta_message_id: message.meta_message_id,
    sent_at: message.sent_at,
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = apiMessageSendSchema.parse(req.body);

  if (data.client_id !== req.clientId) {
    return sendApiError(res, 403, 'client_id_mismatch', 'client_id does not match this API key\'s client.');
  }

  const contact = await contactsRepo.upsertByPhone(pool, req.clientId, { phone: data.to });
  const chat = await chatsRepo.findOrCreateByContact(pool, req.clientId, contact);

  // Real bug, fixed: this used to hardcode 'en_US' for every template send
  // regardless of what language the template was actually approved under —
  // Meta rejects a send whose language doesn't match the approved
  // (name, language) pair, so any client with a non-en_US template (e.g.
  // plain 'en', or any other locale) had every Hub API template send
  // silently fail. The real approved language lives on the local
  // message_templates row (synced from Meta) — same lookup
  // routes/broadcasts.js already uses for this exact purpose. If no local
  // row exists, this fails clearly (400) rather than guessing a language
  // and risking the identical class of silent Meta rejection this fix is
  // closing — a client with a missing/unsynced template should sync it
  // first (POST /api/templates/sync), not have this endpoint guess for them.
  let templateLanguage;
  if (data.type === 'template') {
    const template = await messageTemplatesRepo.findByNameAndClient(pool, req.clientId, data.template);
    if (!template) {
      return sendApiError(res, 404, 'template_not_found',
        `No local record of template "${data.template}" — sync templates (POST /api/templates/sync) so its real approved language can be resolved, then retry.`);
    }
    templateLanguage = template.language;
  }

  try {
    const message = await messagingService.sendChatMessage(pool, req.clientId, chat, {
      type: data.type,
      body: data.body,
      templateName: data.template,
      templateLanguage,
      templateComponents: data.type === 'template' ? metaClient.buildNamedBodyComponents(data.params) : [],
      headerMediaUrl: data.headerMediaUrl,
      // interactive (type: 'interactive') only — buttons routes through
      // sendChatMessage -> metaClient.sendInteractiveMessage, the same path
      // the flow engine's "Send Interactive Buttons" node already uses
      // (flowEngine.js's executeNode); sections routes to the new
      // sendListMessage. Nothing here duplicates either function's
      // Meta-object-building logic. All of these are undefined for
      // text/template sends, matching current behavior exactly for those types.
      header: data.header,
      footer: data.footer,
      buttons: data.buttons,
      button: data.button,
      sections: data.sections,
    });
    res.status(201).json(message);
  } catch (err) {
    if (err instanceof messagingService.MessagingError) {
      const status = err.code === 'send_failed' ? 502 : 409;
      // metaError (see metaClient.js/messagingService.js) is Meta's actual
      // error body, not just the message string — omitted when there isn't
      // one (e.g. a plan-limit or consent rejection never reached Meta).
      return sendApiError(res, status, err.code, err.message, { metaError: err.metaError || undefined });
    }
    throw err;
  }
}));

module.exports = router;
