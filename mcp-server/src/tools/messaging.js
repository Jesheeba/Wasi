// Messaging tools — each wraps POST /api/v1/messages (server/src/routes/
// apiV1Messages.js) or its new GET /:id/status companion. Button/row limits
// below are enforced at the ZOD SCHEMA level (max 3 buttons, max 10 rows
// total across sections) so a calling model gets a schema validation error
// immediately, before the request is even sent — not a round-trip to the
// Hub API to discover the same limit apiMessageSendSchema already enforces
// server-side. The server-side check remains the real source of truth
// (schema-level duplication here is a UX improvement, not a trust boundary).
const { z } = require('zod');
const { hubRequest, getClientId } = require('../hubClient');
const { withToolErrorHandling, toolTextResult } = require('../errors');

const interactiveButtonShape = {
  id: z.string().min(1).max(256).describe('Stable identifier returned in the webhook when this button is tapped — use something your system can match back to an action, not the display text.'),
  title: z.string().min(1).max(20).describe('Button label shown to the recipient. WhatsApp hard limit: 20 characters.'),
};

const listRowShape = {
  id: z.string().min(1).max(200).describe('Stable identifier returned in the webhook when this row is selected.'),
  title: z.string().min(1).max(24).describe('Row label shown to the recipient. WhatsApp hard limit: 24 characters.'),
  description: z.string().max(72).optional().describe('Optional secondary line under the row title. WhatsApp hard limit: 72 characters.'),
};

const listSectionShape = {
  title: z.string().min(1).max(24).optional().describe('Optional section heading shown above its rows.'),
  rows: z.array(z.object(listRowShape)).min(1).describe('One or more rows in this section.'),
};

async function sendMessage(payload) {
  const client_id = await getClientId();
  return hubRequest('POST', '/api/v1/messages', { body: { client_id, ...payload } });
}

const tools = [
  {
    name: 'send_text_message',
    config: {
      title: 'Send WhatsApp text message',
      description:
        'Send a free-form WhatsApp text message to a phone number. Only deliverable if the contact has messaged this WhatsApp number within the last 24 hours (WhatsApp\'s "customer service window") — otherwise this fails with session_window_closed and you should use send_template_message instead. Returns the created message with its id (usable with get_message_status) and delivery status.',
      inputSchema: {
        to: z.string().min(1).describe('Recipient phone number in international format, e.g. "919876543210" (no leading +).'),
        body: z.string().min(1).describe('The message text to send.'),
      },
    },
    handler: withToolErrorHandling(async ({ to, body }) => {
      const message = await sendMessage({ to, type: 'text', body });
      return toolTextResult(message);
    }),
  },
  {
    name: 'send_template_message',
    config: {
      title: 'Send WhatsApp template message',
      description:
        'Send a pre-approved WhatsApp message template to a phone number. Unlike send_text_message, this works any time (no 24-hour window restriction) and is required for the first message to a contact or for marketing/utility campaigns. The template must already be approved by Meta — use list_templates first to confirm the name and see what {{parameters}} it needs, and get_template_details for the full parameter list. Marketing templates additionally require the contact to have opted in (fails with consent_required otherwise).',
      inputSchema: {
        to: z.string().min(1).describe('Recipient phone number in international format, e.g. "919876543210" (no leading +).'),
        template: z.string().min(1).describe('The exact, case-sensitive template name as it appears in list_templates output.'),
        params: z.record(z.string(), z.string()).optional().describe('Named parameter values for the template body, keyed by parameter name (e.g. {"customer_name": "Asha"}). Omit for a template with no variables — check get_template_details for the exact parameter names this template expects.'),
        header_media_url: z.string().url().startsWith('https://').optional().describe('For a template with an image/video/document header only: an HTTPS URL to the specific media file to send instead of the template\'s default approval-time sample.'),
      },
    },
    handler: withToolErrorHandling(async ({ to, template, params, header_media_url }) => {
      const message = await sendMessage({
        to,
        type: 'template',
        template,
        params,
        headerMediaUrl: header_media_url,
      });
      return toolTextResult(message);
    }),
  },
  {
    name: 'send_button_message',
    config: {
      title: 'Send WhatsApp interactive button message',
      description:
        'Send a free-form WhatsApp message with up to 3 tappable reply buttons. Same 24-hour session-window restriction as send_text_message — use a template if the window has closed. No template approval needed, since this is free-form. The recipient\'s tap comes back as a webhook event carrying the button\'s id.',
      inputSchema: {
        to: z.string().min(1).describe('Recipient phone number in international format, e.g. "919876543210" (no leading +).'),
        body: z.string().min(1).max(1024).describe('Main message text (max 1024 characters).'),
        buttons: z.array(z.object(interactiveButtonShape)).min(1).max(3).describe('1 to 3 reply buttons — WhatsApp\'s hard limit is 3 per message.'),
        header: z.string().min(1).max(60).optional().describe('Optional header text above the body (max 60 characters).'),
        footer: z.string().min(1).max(60).optional().describe('Optional footer text below the buttons (max 60 characters).'),
      },
    },
    handler: withToolErrorHandling(async ({ to, body, buttons, header, footer }) => {
      const message = await sendMessage({ to, type: 'interactive', body, buttons, header, footer });
      return toolTextResult(message);
    }),
  },
  {
    name: 'send_list_message',
    config: {
      title: 'Send WhatsApp interactive list message',
      description:
        'Send a free-form WhatsApp message with a button that opens a scrollable list of selectable rows, grouped into sections. Use this instead of send_button_message when you need more than 3 options. Same 24-hour session-window restriction as send_text_message. WhatsApp allows at most 10 rows total across ALL sections combined, not per section. The recipient\'s selection comes back as a webhook event carrying the row\'s id.',
      inputSchema: {
        to: z.string().min(1).describe('Recipient phone number in international format, e.g. "919876543210" (no leading +).'),
        body: z.string().min(1).max(1024).describe('Main message text (max 1024 characters).'),
        button: z.string().min(1).max(20).describe('Label on the button that opens the list (max 20 characters) — distinct from any row\'s title.'),
        sections: z.array(z.object(listSectionShape)).min(1).max(10)
          .refine(
            (sections) => sections.reduce((sum, s) => sum + s.rows.length, 0) <= 10,
            { message: 'WhatsApp allows at most 10 rows total across all sections combined, not per section.' }
          )
          .describe('1 to 10 sections. The TOTAL row count across every section combined must not exceed 10.'),
        header: z.string().min(1).max(60).optional().describe('Optional header text above the body (max 60 characters).'),
        footer: z.string().min(1).max(60).optional().describe('Optional footer text below the body (max 60 characters).'),
      },
    },
    handler: withToolErrorHandling(async ({ to, body, button, sections, header, footer }) => {
      const message = await sendMessage({ to, type: 'interactive', body, button, sections, header, footer });
      return toolTextResult(message);
    }),
  },
  {
    name: 'get_message_status',
    config: {
      title: 'Get WhatsApp message delivery status',
      description:
        'Look up the current delivery status (pending, sent, delivered, read, or failed) of a previously sent message, by the message id returned from send_text_message/send_template_message/send_button_message/send_list_message. If the status is "failed", the response includes the failure reason.',
      inputSchema: {
        message_id: z.string().uuid().describe('The `id` field from a previous send tool\'s response — not WhatsApp\'s own wamid.* message id.'),
      },
    },
    handler: withToolErrorHandling(async ({ message_id }) => {
      const status = await hubRequest('GET', `/api/v1/messages/${message_id}/status`);
      return toolTextResult(status);
    }),
  },
];

module.exports = { tools };
