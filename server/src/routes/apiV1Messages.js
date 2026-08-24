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
const messagingService = require('../services/messagingService');
const metaClient = require('../utils/metaClient');
const { asyncHandler } = require('../utils/asyncHandler');
const { apiMessageSendSchema } = require('../utils/validate');
const { requireApiKey } = require('../middleware/requireApiKey');

const router = Router();
router.use(requireApiKey);

router.post('/', asyncHandler(async (req, res) => {
  const data = apiMessageSendSchema.parse(req.body);

  if (data.client_id !== req.clientId) {
    return res.status(403).json({ error: 'client_id does not match this API key\'s client' });
  }

  const contact = await contactsRepo.upsertByPhone(pool, req.clientId, { phone: data.to });
  const chat = await chatsRepo.findOrCreateByContact(pool, req.clientId, contact);

  try {
    const message = await messagingService.sendChatMessage(pool, req.clientId, chat, {
      type: data.type,
      body: data.body,
      templateName: data.template,
      templateLanguage: 'en_US',
      templateComponents: data.type === 'template' ? metaClient.buildNamedBodyComponents(data.params) : [],
      headerMediaUrl: data.headerMediaUrl,
    });
    res.status(201).json(message);
  } catch (err) {
    if (err instanceof messagingService.MessagingError) {
      const status = err.code === 'send_failed' ? 502 : 409;
      // metaError (see metaClient.js/messagingService.js) is Meta's actual
      // error body, not just the message string — omitted when there isn't
      // one (e.g. a plan-limit or consent rejection never reached Meta).
      return res.status(status).json({ error: err.message, code: err.code, metaError: err.metaError || undefined });
    }
    throw err;
  }
}));

module.exports = router;
