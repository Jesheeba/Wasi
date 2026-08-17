// Thin wrapper around the Meta Graph API for WhatsApp Embedded Signup + Cloud API
// provisioning (spec §3). Requires a real Meta App (META_APP_ID/META_APP_SECRET) and
// a WhatsApp product config (META_CONFIG_ID) — none of that exists in dev by default,
// so every call here will fail with a clear error until real credentials are set.
const { validateTemplateText, defaultExampleFor } = require('./templateParams');

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// A template body/header failed local named-parameter validation before ever
// reaching Meta — distinct from a real Graph API rejection so callers (the
// templates route) can return 400 instead of 502.
class TemplateValidationError extends Error {
  constructor(errors) {
    super(errors.join(' '));
    this.errors = errors;
  }
}

function assertConfigured() {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    throw new Error('META_APP_ID / META_APP_SECRET are not configured (see .env.example)');
  }
}

async function graphFetch(path, { method = 'GET', accessToken, body } = {}) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  if (accessToken && method === 'GET') url.searchParams.set('access_token', accessToken);

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken && method !== 'GET' ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `Meta Graph API error (${res.status})`;
    throw new Error(message);
  }
  return data;
}

// Exchanges the Embedded Signup authorization code for a short-lived user
// access token (spec §3 step 4, first half).
async function exchangeCodeForToken(code) {
  assertConfigured();
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set('client_id', process.env.META_APP_ID);
  url.searchParams.set('client_secret', process.env.META_APP_SECRET);
  url.searchParams.set('code', code);

  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Token exchange failed (${res.status})`);
  }
  return data.access_token;
}

// Converts a short-lived user token into a long-lived one (~60 days) via the
// fb_exchange_token grant (spec §3 step 4, second half). This is the token
// that should actually be persisted — a short-lived token alone expires
// within hours and can't support an ongoing client relationship.
async function exchangeForLongLivedToken(shortLivedToken) {
  assertConfigured();
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', process.env.META_APP_ID);
  url.searchParams.set('client_secret', process.env.META_APP_SECRET);
  url.searchParams.set('fb_exchange_token', shortLivedToken);

  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Long-lived token exchange failed (${res.status})`);
  }
  return data.access_token;
}

async function subscribeAppToWaba(wabaId, accessToken) {
  return graphFetch(`/${wabaId}/subscribed_apps`, { method: 'POST', accessToken });
}

async function registerPhoneNumber(phoneNumberId, accessToken, pin) {
  return graphFetch(`/${phoneNumberId}/register`, {
    method: 'POST',
    accessToken,
    body: { messaging_product: 'whatsapp', pin },
  });
}

async function getPhoneNumberDetails(phoneNumberId, accessToken) {
  return graphFetch(`/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, { accessToken });
}

// Free-form text — only deliverable inside the 24h customer service window
// (i.e. the contact messaged in within the last 24h). Meta rejects it
// outside that window with a real API error; callers should check
// messagingService's session-window logic first rather than relying on that
// error path, so the UI can explain *why* instead of showing a raw failure.
async function sendTextMessage(phoneNumberId, accessToken, toPhone, body) {
  const data = await graphFetch(`/${phoneNumberId}/messages`, {
    method: 'POST',
    accessToken,
    body: {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'text',
      text: { body },
    },
  });
  return data.messages?.[0]?.id;
}

// Builds the `components` array for sending a template whose BODY uses
// named parameters — `paramValues` is { [param_name]: value }. Unlike the
// old positional shape (an ordered array), each object here carries its own
// `parameter_name`, so order doesn't matter. Pass {} (or omit) for a
// template with no variables — sendTemplateMessage defaults `components` to [].
function buildNamedBodyComponents(paramValues) {
  const names = Object.keys(paramValues || {});
  if (names.length === 0) return [];
  return [{
    type: 'body',
    parameters: names.map((parameter_name) => ({
      type: 'text',
      parameter_name,
      text: String(paramValues[parameter_name]),
    })),
  }];
}

// Template messages — deliverable any time (business-initiated), required
// outside the 24h window and for all broadcast/campaign sends. `components`
// follows Meta's template component array shape — build it with
// buildNamedBodyComponents() for a template with named body parameters, or
// pass [] for a template with no variables.
async function sendTemplateMessage(phoneNumberId, accessToken, toPhone, { name, language = 'en_US', components = [] }) {
  const data = await graphFetch(`/${phoneNumberId}/messages`, {
    method: 'POST',
    accessToken,
    body: {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'template',
      template: { name, language: { code: language }, components },
    },
  });
  return data.messages?.[0]?.id;
}

// Builds the Meta Graph API request body for template creation — separated
// from the actual fetch call so it's unit-testable without a real Meta App
// (see server/test/templateParams.test.js). Throws TemplateValidationError
// if the body fails named-parameter validation (numbered params, mixed
// numbered/named, or a variable at the very start/end).
function buildTemplateCreatePayload({ name, category, language = 'en_US', body }) {
  const validation = validateTemplateText(body, { label: 'Body' });
  if (!validation.valid) throw new TemplateValidationError(validation.errors);

  const bodyComponent = { type: 'BODY', text: body };
  if (validation.params.length > 0) {
    bodyComponent.example = {
      body_text_named_params: validation.params.map((param_name) => ({
        param_name,
        example: defaultExampleFor(param_name),
      })),
    };
  }

  const payload = {
    name,
    category: category.toUpperCase(),
    language,
    components: [bodyComponent],
  };
  // Omitted entirely for a template with no variables — Meta defaults to
  // "positional" when absent, which is irrelevant with zero parameters.
  if (validation.paramFormat === 'named') payload.parameter_format = 'named';
  return payload;
}

// Submits a message template to Meta for approval. Approval status arrives
// asynchronously via the `message_template_status_update` webhook field
// (already handled in metaWebhook.js) — this call just registers it.
async function createMessageTemplate(wabaId, accessToken, templateData) {
  const payload = buildTemplateCreatePayload(templateData);
  const data = await graphFetch(`/${wabaId}/message_templates`, {
    method: 'POST',
    accessToken,
    body: payload,
  });
  return data; // { id, status, category }
}

module.exports = {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  subscribeAppToWaba,
  registerPhoneNumber,
  getPhoneNumberDetails,
  sendTextMessage,
  sendTemplateMessage,
  buildNamedBodyComponents,
  buildTemplateCreatePayload,
  createMessageTemplate,
  TemplateValidationError,
};
