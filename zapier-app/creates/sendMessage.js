// Reuses POST /api/v1/messages (server/src/routes/apiV1Messages.js) exactly
// as it is — no new send logic. Scoped to text + template message types
// only for this first version (Phase 0 decision): Wasi's interactive
// button/list types need dynamic field mapping that doesn't fit Zapier's
// static form-field UI well. Documented as a known gap (CLAUDE.md), not
// built here.
//
// client_id is fetched fresh via GET /api/v1/account rather than cached in
// authData — Zapier create actions run as short-lived, possibly separate
// invocations, so there's no long-lived process to hold an in-memory cache
// the way mcp-server/src/hubClient.js's getClientId does for its one
// long-running process. The extra round trip is negligible against a
// message send.
const getClientId = (z, bundle) =>
  z.request({ url: '/api/v1/account' }).then((response) => response.json.client_id);

const perform = async (z, bundle) => {
  const client_id = await getClientId(z, bundle);
  const body = { client_id, to: bundle.inputData.to, type: bundle.inputData.message_type };

  if (bundle.inputData.message_type === 'template') {
    body.template = bundle.inputData.template_name;
    if (bundle.inputData.params) {
      try {
        body.params = JSON.parse(bundle.inputData.params);
      } catch (err) {
        throw new z.errors.Error(
          `Template Parameters must be valid JSON, e.g. {"customer_name": "Asha"}. Got: ${bundle.inputData.params}`,
          'invalid_params_json',
          400
        );
      }
    }
  } else {
    body.body = bundle.inputData.body;
  }

  const response = await z.request({ url: '/api/v1/messages', method: 'POST', body });
  return response.json;
};

module.exports = {
  key: 'send_message',
  noun: 'Message',
  display: {
    label: 'Send WhatsApp Message',
    description: 'Sends a text or template WhatsApp message through your Wasi-connected number.',
  },
  operation: {
    inputFields: [
      {
        key: 'to', label: 'To (phone number)', type: 'string', required: true,
        helpText: 'International format, e.g. 919876543210 (no leading +).',
      },
      {
        key: 'message_type', label: 'Message Type', type: 'string', required: true, default: 'text',
        choices: {
          text: 'Text (only deliverable within 24h of the customer\'s last message)',
          template: 'Template (pre-approved, works any time)',
        },
      },
      { key: 'body', label: 'Message Text', type: 'text', helpText: 'Required for Text messages. Ignored for Template messages.' },
      { key: 'template_name', label: 'Template Name', type: 'string', helpText: 'Required for Template messages — the exact, case-sensitive approved template name.' },
      { key: 'params', label: 'Template Parameters (JSON)', type: 'string', helpText: 'Optional, Template messages only. Named parameter values as JSON, e.g. {"customer_name": "Asha"}.' },
    ],
    perform,
    sample: {
      id: '44444444-4444-4444-4444-444444444444',
      chat_id: '11111111-1111-1111-1111-111111111111',
      direction: 'out',
      status: 'sent',
      sent_at: '2026-01-01T12:00:00.000Z',
    },
  },
};
