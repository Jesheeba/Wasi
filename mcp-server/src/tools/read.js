// Read-only tools — each wraps one GET endpoint under server/src/routes/
// apiV1*.js. `limit` fields default and cap to the same bounds those routes
// enforce server-side (see apiV1Conversations.js/apiV1Contacts.js) — kept
// here too so the tool schema itself documents the ceiling to a calling
// model, not just a runtime 400 if it guesses too high.
const { z } = require('zod');
const { hubRequest, getClientId } = require('../hubClient');
const { withToolErrorHandling, toolTextResult } = require('../errors');

const tools = [
  {
    name: 'list_templates',
    config: {
      title: 'List WhatsApp message templates',
      description:
        'List every WhatsApp message template on this account, including its Meta approval status (approved, pending, or rejected). Always check this before calling send_template_message — sending an unapproved template will fail. Use get_template_details for one template\'s full parameter list.',
      inputSchema: {},
    },
    handler: withToolErrorHandling(async () => {
      const templates = await hubRequest('GET', '/api/v1/templates');
      return toolTextResult(templates);
    }),
  },
  {
    name: 'get_template_details',
    config: {
      title: 'Get WhatsApp template details',
      description:
        'Get the full stored definition of one WhatsApp message template — body text, header/footer, buttons, and the named parameters its body expects (with example values) — so you know exactly what to pass as `params` to send_template_message.',
      inputSchema: {
        template_id: z.string().uuid().describe('The template\'s `id` field, from list_templates.'),
      },
    },
    handler: withToolErrorHandling(async ({ template_id }) => {
      const template = await hubRequest('GET', `/api/v1/templates/${template_id}`);
      return toolTextResult(template);
    }),
  },
  {
    name: 'list_conversations',
    config: {
      title: 'List WhatsApp conversations',
      description:
        'List this account\'s WhatsApp conversations (chats), most recently active first. Each entry includes the chat id (needed for get_conversation_history) and the contact\'s name/phone.',
      inputSchema: {
        limit: z.coerce.number().int().min(1).max(100).default(20).describe('Maximum conversations to return (1-100, default 20). Kept small by default to avoid flooding your context — raise it only if you specifically need more.'),
      },
    },
    handler: withToolErrorHandling(async ({ limit }) => {
      const conversations = await hubRequest('GET', '/api/v1/conversations', { query: { limit } });
      return toolTextResult(conversations);
    }),
  },
  {
    name: 'get_conversation_history',
    config: {
      title: 'Get WhatsApp conversation history',
      description:
        'Get the most recent messages (both inbound and outbound) in one WhatsApp conversation, oldest first. Use list_conversations or search_contacts first to find the chat id.',
      inputSchema: {
        chat_id: z.string().uuid().describe('The conversation\'s id, from list_conversations.'),
        limit: z.coerce.number().int().min(1).max(200).default(50).describe('Maximum messages to return (1-200, default 50), taken from the most recent end of the conversation.'),
      },
    },
    handler: withToolErrorHandling(async ({ chat_id, limit }) => {
      const messages = await hubRequest('GET', `/api/v1/conversations/${chat_id}/messages`, { query: { limit } });
      return toolTextResult(messages);
    }),
  },
  {
    name: 'search_contacts',
    config: {
      title: 'Search WhatsApp contacts',
      description:
        'Search this account\'s contacts by exact phone number or a name/phone substring. Pass `phone` for an exact lookup (fastest, most precise); pass `query` for a fuzzy name/phone search. Provide one or the other, not both.',
      inputSchema: {
        query: z.string().min(1).optional().describe('Case-insensitive substring to match against contact name or phone.'),
        phone: z.string().min(1).optional().describe('Exact phone number to look up, in the same format contacts are stored (international, no leading +).'),
        limit: z.coerce.number().int().min(1).max(100).default(20).describe('Maximum contacts to return for a `query` search (1-100, default 20). Ignored for an exact `phone` lookup.'),
      },
    },
    handler: withToolErrorHandling(async ({ query, phone, limit }) => {
      const contacts = await hubRequest('GET', '/api/v1/contacts', { query: { q: query, phone, limit } });
      return toolTextResult(contacts);
    }),
  },
  {
    name: 'get_account_status',
    config: {
      title: 'Get Wasi account / WhatsApp connection status',
      description:
        'Check whether this Wasi account has a connected WhatsApp Business number, and its Meta quality rating. Useful for self-diagnosing a send failure — a waba_not_connected error means there\'s nothing connected yet.',
      inputSchema: {},
    },
    handler: withToolErrorHandling(async () => {
      const status = await hubRequest('GET', '/api/v1/account');
      return toolTextResult(status);
    }),
  },
  {
    name: 'get_rate_limit_status',
    config: {
      title: 'Get Hub API rate limit',
      description:
        'Get the Wasi Hub API\'s request rate ceiling for this account. This is the account-wide limit shared across every Hub API call (sends and reads alike) — use it to pace a burst of sends (e.g. a broadcast) rather than firing requests until one gets rate-limited.',
      inputSchema: {},
    },
    handler: withToolErrorHandling(async () => {
      const rateLimit = await hubRequest('GET', '/api/v1/account/rate-limit');
      return toolTextResult(rateLimit);
    }),
  },
];

module.exports = { tools };
