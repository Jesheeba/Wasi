// Thin fetch wrapper around Wasi's Hub API (server/src/routes/apiV1*.js).
// Every tool in src/tools/ goes through this — no tool ever builds its own
// fetch call — so auth, error normalization, and the "never log the key"
// rule live in exactly one place.
//
// Security note: the raw API key is read from process.env.WASI_API_KEY once
// and held only in memory for the process's lifetime. It is never logged,
// never included in a tool's returned content, and never written to disk —
// see README.md's "Security" section for the full statement.

class HubApiError extends Error {
  constructor(message, { status, code, metaError, details } = {}) {
    super(message);
    this.name = 'HubApiError';
    this.status = status ?? null;
    this.code = code ?? null;
    this.metaError = metaError ?? null;
    this.details = details ?? null;
  }
}

// WASI_API_BASE_URL has no built-in default — Wasi is deployed per-instance
// (there is no single fixed public domain for every user of this server the
// way there is for, say, a single-tenant SaaS API), so guessing one here
// would silently point at the wrong backend instead of failing clearly.
function getConfig() {
  const apiKey = process.env.WASI_API_KEY;
  if (!apiKey) {
    throw new HubApiError(
      'WASI_API_KEY is not set. Configure it as an environment variable in your MCP client config (see this package\'s README) before calling any Wasi tool.',
      { code: 'missing_api_key' }
    );
  }
  const rawBaseUrl = process.env.WASI_API_BASE_URL;
  if (!rawBaseUrl) {
    throw new HubApiError(
      'WASI_API_BASE_URL is not set. Set it to your Wasi instance\'s base URL (e.g. https://your-wasi-domain.example) in your MCP client config.',
      { code: 'missing_base_url' }
    );
  }
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  return { apiKey, baseUrl };
}

// path e.g. '/api/v1/messages'; query is a flat object of primitives,
// undefined/null entries are omitted (so a tool can pass every optional arg
// through unconditionally without hand-building the query string).
async function hubRequest(method, path, { query, body } = {}) {
  const { apiKey, baseUrl } = getConfig();
  const url = new URL(`${baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new HubApiError(
      `Could not reach the Wasi Hub API at ${baseUrl} (${err.message}). Check WASI_API_BASE_URL and your network connection.`,
      { code: 'network_error' }
    );
  }

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON body (e.g. an upstream proxy error page) — fall through
      // with an empty object so the status-based error below still fires
      // with a sane message instead of throwing on the body itself.
    }
  }

  if (!res.ok) {
    // Hub API v1's error shape is { error: { code, message, ...extra } }
    // (server/src/utils/apiError.js) — every /api/v1/* endpoint returns
    // this same nested shape now, so there's exactly one place to parse it.
    const errBody = data.error && typeof data.error === 'object' ? data.error : {};
    throw new HubApiError(errBody.message || `Hub API request failed (HTTP ${res.status})`, {
      status: res.status,
      code: errBody.code,
      metaError: errBody.metaError,
      details: errBody.details,
    });
  }
  return data;
}

// Resolves and caches this API key's own client_id via GET /api/v1/account
// — see that route's comment for why this exists: apiMessageSendSchema
// requires a client_id body field, but no tool caller should ever need to
// know or supply Wasi's internal client UUID. Cached for the process
// lifetime (one MCP server process = one API key = one client, for the
// whole session), not re-fetched per send.
let cachedClientId = null;

async function getClientId() {
  if (cachedClientId) return cachedClientId;
  const account = await hubRequest('GET', '/api/v1/account');
  cachedClientId = account.client_id;
  return cachedClientId;
}

module.exports = { HubApiError, hubRequest, getClientId };
