// Sends one of a client's WhatsApp Forms into a chat. Shared by the chat's
// "Send form" button (routes/chats.js) and the Bot Flow "Send form" step
// (flowEngine.js), so both follow the same rules (whatsapp-flows.md):
// inside the 24h window the free interactive form message; outside it only
// the form's approved "Send anytime" template. Throws MessagingError with a
// code the callers map to a response or a stalled flow.
const messagingService = require('./messagingService');
const flowTemplates = require('../utils/whatsappFlowTemplates');

const { MessagingError } = messagingService;

async function sendForm(db, clientId, chat, flow, { body, cta }, connectionHooks = {}) {
  if (!flow) throw new MessagingError('Form not found', 'form_not_found');
  if (!flow.meta_flow_id || !['draft', 'published'].includes(flow.status)) {
    throw new MessagingError("This form can't be sent: WhatsApp never accepted it, or it has been retired.", 'form_not_sendable');
  }
  const kind = flowTemplates.KINDS[flow.kind];
  // Live forms (endpoint kinds) carry the chat in the token so a booking
  // knows who made it, and open with data_exchange (endpoint INIT).
  const flowToken = flowTemplates.makeFlowToken(flow.id, kind.endpoint ? chat.id : undefined);

  if (await messagingService.canSendFreeform(db, clientId, chat.id)) {
    return messagingService.sendChatMessage(db, clientId, chat, {
      type: 'flow', body,
      flow: {
        name: flow.name, metaFlowId: flow.meta_flow_id, flowToken,
        action: kind.endpoint ? 'data_exchange' : 'navigate',
        cta, screen: kind.screen, mode: flow.status === 'draft' ? 'draft' : 'published',
      },
    }, connectionHooks);
  }
  if (!flow.template_name) {
    throw new MessagingError("This customer hasn't messaged in the last 24 hours. Make a template for this form on the Forms page to send it anytime.", 'session_window_closed');
  }
  const t = await db.query('select name, language, status from message_templates where client_id = $1 and name = $2 order by created_at desc limit 1', [clientId, flow.template_name]);
  const template = t.rows[0];
  if (!template || template.status !== 'approved') {
    throw new MessagingError(`This customer hasn't messaged in the last 24 hours, and the form's template is ${template ? template.status : 'missing'}. It can be sent once WhatsApp approves it.`, 'template_not_approved');
  }
  return messagingService.sendChatMessage(db, clientId, chat, {
    type: 'template', templateName: template.name, templateLanguage: template.language,
    templateComponents: [{ type: 'button', sub_type: 'flow', index: '0', parameters: [{ type: 'action', action: { flow_token: flowToken } }] }],
  }, connectionHooks);
}

module.exports = { sendForm };
