// The model call (SPEC sections 9.5 and 12) through the official SDK.
// - No temperature: API version 2026-10-21 rejects sampling parameters on
//   every model (departure from SPEC 9.5, recorded in the feature doc).
// - maxRetries 1: the SDK retries 408/409/429/5xx and connection errors once.
// - 10 s timeout, then the caller hands over (a customer waiting 30 s is worse).
// Exported functions are replaced by tests through module.exports, so callers
// must use `model.callModel(...)`, not a destructured copy.
const SDK = require('@anthropic-ai/sdk');
const config = require('./config');

const Anthropic = SDK.default || SDK;
const MAX_TOKENS = 300;
const TIMEOUT_MS = 10000;

// USD per million tokens [input, output] (claude-api reference, 2026-11-03).
const PRICES = {
  'claude-haiku-4-5': [1, 5],
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-sonnet-5-5': [2, 10],
};
const ALLOWED_MODELS = Object.keys(PRICES);

// Integers, never floats, for money (SPEC section 6).
function costPaise(model, tokensIn, tokensOut) {
  const [pin, pout] = PRICES[model] || PRICES[config.DEFAULT_MODEL];
  return Math.round(((tokensIn * pin + tokensOut * pout) / 1e6) * config.USD_TO_INR * 100);
}

// Haiku 5.5 runs adaptive thinking at medium effort by default; for a short
// WhatsApp answer turn it off (allowed at effort high or below) so the 300
// token budget is spent on the reply. Haiku 4.5 has no thinking by default.
function modelParams(model) {
  return model === 'claude-haiku-5-5' ? { thinking: { type: 'disabled' } } : {};
}

async function callModel({ apiKey, model, system, messages }) {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: TIMEOUT_MS });
  const started = Date.now();
  const res = await client.messages.create({ model, max_tokens: MAX_TOKENS, system, messages, ...modelParams(model) });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const u = res.usage || {};
  const tokensIn = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  return {
    text,
    stopReason: res.stop_reason,
    tokensIn,
    tokensCached: u.cache_read_input_tokens || 0,
    tokensOut: u.output_tokens || 0,
    costPaise: costPaise(model, tokensIn, u.output_tokens || 0),
    latencyMs: Date.now() - started,
  };
}

// Exact token count from the API (decision 20), used for the knowledge meter
// and to validate a key when it is saved (the endpoint is free to call).
async function countTokens({ apiKey, model, text }) {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: TIMEOUT_MS });
  const res = await client.messages.countTokens({ model, messages: [{ role: 'user', content: text || '.' }] });
  return res.input_tokens;
}

// Classifies an SDK error for the user without leaking anything from it.
function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'invalid_api_key';
  if (err instanceof Anthropic.PermissionDeniedError) return 'key_not_permitted';
  if (err instanceof Anthropic.RateLimitError) return 'rate_limited_by_provider';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (err instanceof Anthropic.APIConnectionError) return 'connection_error';
  if (err instanceof Anthropic.APIError) return `provider_error_${err.status || 'unknown'}`;
  return 'unknown_error';
}

module.exports = { callModel, countTokens, describeError, costPaise, ALLOWED_MODELS, MAX_TOKENS };
