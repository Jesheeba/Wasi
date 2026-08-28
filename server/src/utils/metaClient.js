// Thin wrapper around the Meta Graph API for WhatsApp Embedded Signup + Cloud API
// provisioning (spec §3). Requires a real Meta App (META_APP_ID/META_APP_SECRET) and
// a WhatsApp product config (META_CONFIG_ID) — none of that exists in dev by default,
// so every call here will fail with a clear error until real credentials are set.
const { validateTemplateText, validateHeaderText, defaultExampleFor } = require('./templateParams');

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Every Graph API call below goes through this instead of raw fetch() so a
// stalled request (Meta-side network issue, not the normal multi-minute
// Coexistence phone-linking wait — that happens entirely inside the FB.login
// popup, before any of these calls run) fails after a bounded time instead of
// hanging the connect route forever. Upload/download calls get a longer
// budget since they carry real file bytes (up to 100MB documents), not just
// small JSON payloads.
const DEFAULT_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(url, options = {}, ms = DEFAULT_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Meta API request timed out after ${Math.round(ms / 1000)}s`);
    }
    throw err;
  }
}

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

  const res = await fetchWithTimeout(url, {
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
    const error = new Error(message);
    // Attached, not just the message string — the hub API (routes/
    // apiV1Messages.js) returns this to the calling app so it can act on
    // error_subcode (e.g. 131047 = 24h window closed) rather than parsing
    // a human-readable sentence. Purely additive: existing callers that
    // only read err.message are unaffected.
    error.metaError = data?.error || null;
    throw error;
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

  const res = await fetchWithTimeout(url);
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

  const res = await fetchWithTimeout(url);
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

// profile_picture_url here is a Meta-hosted CDN link for DISPLAY only —
// setting a new picture is a different field (profile_picture_handle,
// write-only, obtained via the Resumable Upload API), not interchangeable.
async function getBusinessProfile(phoneNumberId, accessToken) {
  return graphFetch(
    `/${phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,vertical,websites`,
    { accessToken }
  );
}

// `fields` is forwarded as-is — routes/onboarding.js is responsible for it
// containing only the keys the caller actually wants changed (see
// businessProfileUpdateSchema, an all-optional partial schema, and the
// route's own trim-and-drop-blank pass). This function does no filtering of
// its own; sending a field here sets it on the live profile, full stop.
async function updateBusinessProfile(phoneNumberId, accessToken, fields) {
  return graphFetch(`/${phoneNumberId}/whatsapp_business_profile`, {
    method: 'POST',
    accessToken,
    body: { messaging_product: 'whatsapp', ...fields },
  });
}

// Resumable Upload API (https://developers.facebook.com/docs/graph-api/guides/upload/)
// — the mechanism for both a business profile picture (profile_picture_handle)
// and a template media header (example.header_handle). Two steps:
// 1) open a session against the APP (not the WABA/phone number) scoped to
//    one file's size+type, 2) upload the bytes to that session and get back
//    a handle. The session step uses the same Bearer-token convention as
//    every other call in this file (graphFetch handles that); the upload
//    step does NOT — Meta requires the literal "OAuth" scheme there, a
//    real, confirmed inconsistency in their own API, not a typo here.
async function createUploadSession(appId, accessToken, { fileName, fileLength, fileType }) {
  const url = new URL(`${GRAPH_BASE}/${appId}/uploads`);
  url.searchParams.set('file_name', fileName);
  url.searchParams.set('file_length', String(fileLength));
  url.searchParams.set('file_type', fileType);
  url.searchParams.set('access_token', accessToken);

  const res = await fetchWithTimeout(url, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Meta upload-session creation failed (${res.status})`);
  }
  return data; // { id: "upload:<session id>" }
}

async function uploadFileBytes(uploadSessionId, accessToken, buffer) {
  const res = await fetchWithTimeout(`${GRAPH_BASE}/${uploadSessionId}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${accessToken}`,
      file_offset: '0',
    },
    body: buffer,
  }, UPLOAD_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Meta file upload failed (${res.status})`);
  }
  return data; // { h: "<handle>" }
}

// Standard Media API (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media)
// — NOT the Resumable Upload API above. This is the one that mints a
// `media id` usable in an outbound message's header parameter (image/video/
// document). Meta requires this specific upload mechanism for a media
// header's `header_handle` example (createUploadSession/uploadFileBytes),
// but rejects that handle if reused at send time — sending needs a media id
// from here instead. The id is reusable across many messages (confirmed:
// no "consumed on first use" behavior) and expires 30 days after upload —
// see services/mediaHeaderService.js for the cache/refresh built around
// that lifetime.
async function uploadMedia(phoneNumberId, accessToken, buffer, mimeType, filename) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), filename || 'file');

  const res = await fetchWithTimeout(`${GRAPH_BASE}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  }, UPLOAD_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data?.error?.message || `Meta media upload failed (${res.status})`);
    error.metaError = data?.error || null;
    throw error;
  }
  return data; // { id: "<media id>" }
}

// Returns a short-lived (5 minute) download URL for a media id this app
// already holds — used by mediaHeaderService's refresh cycle to pull the
// bytes back from Meta before a cached id's 30-day window closes, rather
// than this app persisting the file itself (see migration
// 028_template_media_cache.js's module comment).
async function getMediaUrl(mediaId, accessToken) {
  return graphFetch(`/${mediaId}`, { accessToken }); // { url, mime_type, sha256, file_size, id }
}

async function downloadMediaBytes(url, accessToken) {
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } }, UPLOAD_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`Meta media download failed (${res.status}) — the media id it was resolved from may have expired.`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: res.headers.get('content-type') || null };
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

// Free-form interactive reply buttons — like sendTextMessage, only
// deliverable inside the 24h customer service window (no template approval
// needed, but same window constraint). Meta caps free-form button messages
// at 3 buttons, 20 chars each — enforced at the schema level for the one
// caller that takes untrusted external input (validate.js's
// apiMessageSendSchema, for the Hub API); the flow engine's own caller
// builds `buttons` from a flow node's own config, authored through the flow
// editor UI, not re-validated here either way, matching how sendTextMessage
// doesn't re-validate body length. `buttons` is [{ id, title }]; `id` is
// what comes back in the webhook's interactive.button_reply.id on click —
// this is the value flow branching matches against, never the (editable)
// title. `header`/`footer` are optional text-only additions (Meta also
// supports image/video/document headers on button messages; not built here
// — no caller has asked for a media header on an interactive message yet,
// unlike template headers which mediaHeaderService.js already handles).
async function sendInteractiveMessage(phoneNumberId, accessToken, toPhone, { bodyText, buttons, header, footer }) {
  const interactive = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
    },
  };
  if (header) interactive.header = { type: 'text', text: header };
  if (footer) interactive.footer = { text: footer };

  const data = await graphFetch(`/${phoneNumberId}/messages`, {
    method: 'POST',
    accessToken,
    body: {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'interactive',
      interactive,
    },
  });
  return data.messages?.[0]?.id;
}

// Interactive list message — Meta's other interactive.type shape, alongside
// sendInteractiveMessage's "button" above. Deliberately its own function,
// not a branch inside sendInteractiveMessage: the object shape
// (action.button + action.sections[].rows[] vs action.buttons[]) and limits
// (10 rows total across every section combined vs 3 buttons) are different
// enough that sharing one function would mean an internal if/else
// duplicating the decision validate.js's apiMessageSendSchema already makes
// by which fields are present (buttons vs sections). Row/section counts and
// lengths, including the combined-10-rows-total limit, are enforced there,
// not re-validated here — same as sendInteractiveMessage not re-validating
// body length. `sections` is [{ title?, rows: [{ id, title, description? }] }].
async function sendListMessage(phoneNumberId, accessToken, toPhone, { bodyText, buttonText, sections, header, footer }) {
  const interactive = {
    type: 'list',
    body: { text: bodyText },
    action: {
      button: buttonText,
      sections: sections.map((s) => ({
        ...(s.title ? { title: s.title } : {}),
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title,
          ...(r.description ? { description: r.description } : {}),
        })),
      })),
    },
  };
  if (header) interactive.header = { type: 'text', text: header };
  if (footer) interactive.footer = { text: footer };

  const data = await graphFetch(`/${phoneNumberId}/messages`, {
    method: 'POST',
    accessToken,
    body: {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'interactive',
      interactive,
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

// Same shape as buildNamedBodyComponents, for a template's HEADER — Meta
// caps a text header at one named parameter (see templateParams.js's
// validateHeaderText), but this doesn't re-enforce that; it just builds
// whatever's passed. Pass {} (or omit) for a template with no header
// variable.
function buildNamedHeaderComponents(paramValues) {
  const names = Object.keys(paramValues || {});
  if (names.length === 0) return [];
  return [{
    type: 'header',
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
// if any piece fails validation. Category-branched: Authentication's shape
// is fundamentally different (Meta generates the body, not the author), so
// it's a genuinely separate builder, not a variant of the same one.
function buildTemplateCreatePayload(templateData) {
  if (templateData.category.toUpperCase() === 'AUTHENTICATION') {
    return buildAuthenticationPayload(templateData);
  }
  return buildUtilityMarketingPayload(templateData);
}

function buildUtilityMarketingPayload({ name, category, language = 'en_US', body, bodyParamExamples, header, footer, buttons }) {
  const bodyValidation = validateTemplateText(body, { label: 'Body' });
  if (!bodyValidation.valid) throw new TemplateValidationError(bodyValidation.errors);

  const components = [];

  if (header && header.type && header.type !== 'NONE') {
    if (header.type === 'TEXT') {
      const headerValidation = validateHeaderText(header.text || '');
      if (!headerValidation.valid) throw new TemplateValidationError(headerValidation.errors);
      const headerComponent = { type: 'HEADER', format: 'TEXT', text: header.text };
      if (headerValidation.params.length > 0) {
        const paramName = headerValidation.params[0];
        headerComponent.example = {
          header_text_named_params: [{
            param_name: paramName,
            example: (bodyParamExamples && bodyParamExamples[paramName]) || defaultExampleFor(paramName),
          }],
        };
      }
      components.push(headerComponent);
    } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.type)) {
      // `handle` is resolved by routes/templates.js via
      // metaClient.createUploadSession/uploadFileBytes BEFORE this is ever
      // called — Meta requires the Resumable Upload API's one-time handle
      // here, not the reusable media id services/mediaHeaderService.js
      // resolves separately for sending. Defensive, not reachable through
      // the normal route: that route always resolves a handle first.
      if (!header.handle) {
        throw new TemplateValidationError([`Header type "${header.type}" requires an uploaded media handle.`]);
      }
      components.push({
        type: 'HEADER',
        format: header.type,
        example: { header_handle: [header.handle] },
      });
    } else {
      throw new TemplateValidationError([`Header type "${header.type}" isn't supported.`]);
    }
  }

  const bodyComponent = { type: 'BODY', text: body };
  if (bodyValidation.params.length > 0) {
    bodyComponent.example = {
      body_text_named_params: bodyValidation.params.map((param_name) => ({
        param_name,
        // Author-supplied sample value is now the source of truth — Meta
        // requires a real example, not just any placeholder (validate.js's
        // messageTemplateCreateSchema enforces one exists per parameter
        // before this is ever reached). defaultExampleFor is only a
        // fallback here in case that guard is ever bypassed.
        example: (bodyParamExamples && bodyParamExamples[param_name]) || defaultExampleFor(param_name),
      })),
    };
  }
  components.push(bodyComponent);

  if (footer) components.push({ type: 'FOOTER', text: footer });

  if (buttons && buttons.length > 0) {
    components.push({
      type: 'BUTTONS',
      buttons: buttons.map((b) => {
        if (b.type === 'URL') return { type: 'URL', text: b.text, url: b.url };
        if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number };
        return { type: 'QUICK_REPLY', text: b.text };
      }),
    });
  }

  const payload = { name, category: category.toUpperCase(), language, components };
  // Omitted entirely for a template with no variables — Meta defaults to
  // "positional" when absent, which is irrelevant with zero parameters.
  if (bodyValidation.paramFormat === 'named') payload.parameter_format = 'named';
  return payload;
}

// Authentication templates don't take an author-written body/header/footer
// at all — Meta generates that text itself from these fixed options. Shape
// per Meta's Authentication Templates docs (not doc-confirmed live the way
// BODY's named-parameter format was — flag same as header/button shapes
// below if Meta rejects this): BODY carries add_security_recommendation,
// FOOTER carries code_expiration_minutes, and exactly one OTP button is
// required. Only COPY_CODE is implemented — Meta also has ONE_TAP, not
// built, wasn't asked for.
function buildAuthenticationPayload({ name, language = 'en_US', codeExpirationMinutes, addSecurityDisclaimer, otpButtonType }) {
  const components = [
    { type: 'BODY', add_security_recommendation: Boolean(addSecurityDisclaimer) },
  ];
  if (codeExpirationMinutes) {
    components.push({ type: 'FOOTER', code_expiration_minutes: codeExpirationMinutes });
  }
  components.push({
    type: 'BUTTONS',
    buttons: [{ type: 'OTP', otp_type: otpButtonType || 'COPY_CODE' }],
  });

  return { name, category: 'AUTHENTICATION', language, components };
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

// Edits an ALREADY-SUBMITTED template in place. Unlike createMessageTemplate,
// this targets the template's own numeric id (not the WABA) — Meta re-
// reviews the new content while the CURRENTLY-APPROVED content keeps
// sending until that review resolves (Meta's own documented "Edit Message
// Templates" behavior), so there's no sendability gap the way there would
// be with delete + recreate. name/language can't be changed this way (the
// id already identifies both); the destructure below just discards the two
// fields Meta's edit endpoint doesn't accept, reusing the exact same
// category/components builder createMessageTemplate uses so create and
// edit can never validate a template's content differently.
async function updateMessageTemplate(templateId, accessToken, templateData) {
  const { name, language, ...editPayload } = buildTemplateCreatePayload(templateData);
  const data = await graphFetch(`/${templateId}`, {
    method: 'POST',
    accessToken,
    body: editPayload,
  });
  return data;
}

// Fetches every template on a WABA, not just the first page — Meta
// paginates this endpoint, and a client with 30+ templates would silently
// lose the tail on a naive single fetch (see services/templateSyncService.js).
// paging.next is a full URL but, confirmed against a real response, does
// NOT carry access_token — re-appended on every page, not just the first.
// MAX_TEMPLATE_PAGES is a safety backstop against a malformed/looping
// paging.next, not a real-world cap (50 pages is thousands of templates).
const LIST_TEMPLATES_FIELDS = 'id,name,status,category,language,components,rejected_reason';
const MAX_TEMPLATE_PAGES = 50;

async function listTemplates(wabaId, accessToken) {
  const all = [];
  let url = new URL(`${GRAPH_BASE}/${wabaId}/message_templates`);
  url.searchParams.set('fields', LIST_TEMPLATES_FIELDS);
  url.searchParams.set('access_token', accessToken);

  for (let page = 0; page < MAX_TEMPLATE_PAGES; page++) {
    const res = await fetchWithTimeout(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error?.message || `Meta Graph API error (${res.status})`;
      const error = new Error(message);
      error.metaError = data?.error || null;
      throw error;
    }
    all.push(...(data.data || []));
    if (!data.paging?.next) return all;
    url = new URL(data.paging.next);
    if (!url.searchParams.get('access_token')) url.searchParams.set('access_token', accessToken);
  }
  console.error(
    `metaClient.listTemplates: hit the ${MAX_TEMPLATE_PAGES}-page safety cap for WABA ${wabaId} — ` +
    `paging.next kept returning more pages than expected; returning what was fetched so far, not looping forever.`
  );
  return all;
}

// Deletes a template on Meta. Unlike createMessageTemplate/listTemplates,
// Meta targets this by query params, not id-in-path or a JSON body — `name`
// alone deletes EVERY language variant sharing that name on the WABA, so
// callers should also pass hsm_id (the template's own meta_template_id) to
// scope the delete to just this one language, matching this app's local
// (name, language) row granularity. Returns { success: true } on Meta's side.
async function deleteMessageTemplate(wabaId, accessToken, name, hsmId) {
  const url = new URL(`${GRAPH_BASE}/${wabaId}/message_templates`);
  url.searchParams.set('name', name);
  if (hsmId) url.searchParams.set('hsm_id', hsmId);
  url.searchParams.set('access_token', accessToken);

  const res = await fetchWithTimeout(url, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `Meta Graph API error (${res.status})`;
    const error = new Error(message);
    error.metaError = data?.error || null;
    throw error;
  }
  return data;
}

// Inverse of buildUtilityMarketingPayload's component construction — turns
// Meta's real `components` array (as returned by listTemplates) into this
// app's local column shape. Deliberately permissive, unlike the authoring
// path: a template synced FROM Meta was already accepted by Meta, so this
// must never throw or reject it — not on numbered {{1}} parameters (older
// templates on a client's WABA will have them; stored as-is, never
// converted or rejected the way authoring through this app's own form
// would be), and not on a component with no `example` at all (a template
// with no variables legitimately has none).
function parseTemplateComponents(components) {
  const list = Array.isArray(components) ? components : [];
  const bodyComponent = list.find((c) => c.type === 'BODY');
  const headerComponent = list.find((c) => c.type === 'HEADER');
  const footerComponent = list.find((c) => c.type === 'FOOTER');
  const buttonsComponent = list.find((c) => c.type === 'BUTTONS');

  const bodyParamExamples = {};
  const namedParams = bodyComponent?.example?.body_text_named_params;
  const positionalParams = bodyComponent?.example?.body_text;
  if (Array.isArray(namedParams)) {
    for (const p of namedParams) {
      if (p?.param_name) bodyParamExamples[p.param_name] = p.example;
    }
  } else if (Array.isArray(positionalParams) && Array.isArray(positionalParams[0])) {
    // Positional/numbered-style example ({{1}}, {{2}}, ...): Meta returns
    // example.body_text as [["value1", "value2"]], lined up with body
    // order, not param names — keyed by position (matching the {{N}}
    // numbering in the body text itself) since there's no name to key by.
    positionalParams[0].forEach((example, i) => {
      bodyParamExamples[String(i + 1)] = example;
    });
  }

  let headerType = 'NONE';
  let headerContent = null;
  if (headerComponent) {
    headerType = headerComponent.format || 'TEXT';
    headerContent = headerType === 'TEXT' ? (headerComponent.text || null) : null;
  }

  let buttons = null;
  if (buttonsComponent?.buttons?.length) {
    buttons = buttonsComponent.buttons.map((b) => ({
      type: b.type,
      text: b.text || null,
      url: b.url || null,
      phone_number: b.phone_number || null,
    }));
  }

  return {
    body: bodyComponent?.text || null,
    bodyParamExamples: Object.keys(bodyParamExamples).length > 0 ? bodyParamExamples : null,
    headerType,
    headerContent,
    footerText: footerComponent?.text || null,
    buttons,
  };
}

module.exports = {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  subscribeAppToWaba,
  registerPhoneNumber,
  getPhoneNumberDetails,
  getBusinessProfile,
  updateBusinessProfile,
  createUploadSession,
  uploadFileBytes,
  uploadMedia,
  getMediaUrl,
  downloadMediaBytes,
  sendTextMessage,
  sendInteractiveMessage,
  sendListMessage,
  sendTemplateMessage,
  buildNamedHeaderComponents,
  buildNamedBodyComponents,
  buildTemplateCreatePayload,
  createMessageTemplate,
  updateMessageTemplate,
  deleteMessageTemplate,
  listTemplates,
  parseTemplateComponents,
  TemplateValidationError,
};
