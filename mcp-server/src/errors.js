// Turns any error a tool handler throws into a structured, model-readable
// MCP tool result (plan doc §7: "every tool's error response must be
// structured and model-readable, not a raw HTTP error dump"). Every tool in
// src/tools/ wraps its handler body in toolError() via withToolErrorHandling
// below, so this is the one place that decides what an agent actually sees
// when something goes wrong.
const { HubApiError } = require('./hubClient');

// Hub API error `code` (messagingService.js's MessagingError codes, plus
// this server's own) -> a plain-English explanation of what it means and
// what to do next. Kept separate from the Hub API's own message text (which
// is already fairly clear) so this adds actionable next-step guidance on
// top, not a duplicate restatement.
const HUB_CODE_HINTS = {
  waba_not_connected: 'This Wasi account has no connected WhatsApp Business number yet — connect one from the Wasi admin panel before sending.',
  consent_required: 'Call search_contacts or check this contact\'s opt-in status — marketing templates can only be sent to contacts who have explicitly opted in.',
  plan_limit_reached: 'This account has hit its monthly conversation limit for the current billing plan. Sending will resume next billing cycle, or after an upgrade.',
  session_window_closed: 'Use send_template_message instead — free-form text/button/list messages only work within 24 hours of the contact\'s last inbound message.',
  media_resolution_failed: 'The template\'s media header (image/video/document) could not be resolved — check the header_media_url, or that the template\'s default sample media is still valid.',
  send_failed: 'Meta (WhatsApp) rejected the send attempt — see the attached Meta error detail, if any, for the specific reason.',
  missing_api_key: 'Set WASI_API_KEY as an environment variable in your MCP client configuration.',
  missing_base_url: 'Set WASI_API_BASE_URL to your Wasi instance\'s base URL in your MCP client configuration.',
  network_error: 'The Wasi Hub API could not be reached — check WASI_API_BASE_URL and network connectivity.',
  last_active_key: 'This is the account\'s only active API key and cannot be removed without a replacement.',
};

// Meta Graph API error codes worth explaining in plain English — not
// exhaustive (Meta has hundreds), just the ones a normal send is actually
// likely to hit. See metaClient.js's graphFetch for how metaError is
// attached to a Hub API error response in the first place.
const META_ERROR_HINTS = {
  131047: 'The 24-hour customer service window is closed for this recipient — send a template message instead of free-form text/interactive.',
  131026: 'This number has not messaged your WhatsApp Business number before (or has blocked it) — an approved template is required for the first outbound message.',
  131009: 'One or more parameter values in this request failed WhatsApp\'s validation (e.g. a malformed phone number).',
  132000: 'Template parameter validation failed — check that every {{parameter}} placeholder in the template has a matching value.',
  132001: 'This template name/language pair isn\'t recognized by Meta — call list_templates to see what\'s actually approved for this account.',
  132005: 'This template has been paused by Meta due to quality/engagement issues and cannot currently be sent.',
  132007: 'This template was rejected by Meta and cannot be used to send messages.',
  190: 'The connected WhatsApp Business number\'s access token is invalid or expired — it needs to be reconnected from the Wasi admin panel.',
};

function formatHubApiError(err) {
  const parts = [err.message];

  const hint = err.code ? HUB_CODE_HINTS[err.code] : null;
  if (hint) parts.push(hint);

  if (err.metaError?.code && META_ERROR_HINTS[err.metaError.code]) {
    parts.push(META_ERROR_HINTS[err.metaError.code]);
  } else if (err.metaError?.message) {
    parts.push(`Meta's own error: ${err.metaError.message}`);
  }

  if (Array.isArray(err.details) && err.details.length) {
    parts.push(err.details.join(' '));
  }

  if (err.code) parts.push(`[error code: ${err.code}]`);

  return parts.filter(Boolean).join(' ');
}

// A tool handler's return value on failure — MCP's CallToolResult shape
// with isError: true, which surfaces the text to the model as the tool's
// output (distinct from a protocol-level error, which would hide the
// message from the model entirely).
function toolErrorResult(err) {
  const text = err instanceof HubApiError
    ? formatHubApiError(err)
    : `Unexpected error: ${err?.message || String(err)}`;
  return { content: [{ type: 'text', text }], isError: true };
}

// Wraps a tool's async handler so any thrown error (HubApiError from
// hubClient, a zod .parse() failure from a tool's own extra validation, or
// anything else) becomes a structured isError result instead of an
// unhandled rejection the MCP SDK would otherwise turn into a bare
// protocol-level error with no explanation the model can act on.
function withToolErrorHandling(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      return toolErrorResult(err);
    }
  };
}

function toolTextResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

module.exports = { toolErrorResult, withToolErrorHandling, toolTextResult };
