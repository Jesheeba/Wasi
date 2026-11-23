// Who may run the AI agent, and on whose API key. Read from the environment on
// every call so a change needs only a restart, never a deploy.
//
// AI_LIVE_ALLOWLIST - the legal gate (SPEC decision 24 / P6) in code.
//   Comma-separated `clientId:phone10` pairs (`clientId:*` = every number of
//   that client), or `*` for everyone once legal sign-off is done.
//   UNSET OR EMPTY MEANS NOBODY: the agent never calls a model on a real
//   customer's message until someone deliberately opens it. Fails closed.
// AI_PLATFORM_KEY_CLIENT_IDS - clients allowed to use the platform key
//   ANTHROPIC_API_KEY (the Wasi Demo Client, for testing). Everyone else
//   brings their own key (owner decision 2026-11-23).
const digits = (v) => String(v || '').replace(/\D/g, '');

function parseList(name) {
  return String(process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// True when this client may have the agent at all (used to decide whether a
// job is even enqueued, and to gate enabling in Settings).
function pilotIncludesClient(clientId) {
  const list = parseList('AI_LIVE_ALLOWLIST');
  return list.includes('*') || list.some((entry) => entry.split(':')[0] === clientId);
}

// True when this exact customer number may receive an AI reply.
function pilotAllows(clientId, phone) {
  const list = parseList('AI_LIVE_ALLOWLIST');
  if (list.includes('*')) return true;
  const last10 = digits(phone).slice(-10);
  return list.some((entry) => {
    const [id, number] = entry.split(':');
    if (id !== clientId) return false;
    return number === '*' || (last10.length === 10 && digits(number).slice(-10) === last10);
  });
}

function platformKeyAllowed(clientId) {
  return Boolean(process.env.ANTHROPIC_API_KEY) && parseList('AI_PLATFORM_KEY_CLIENT_IDS').includes(clientId);
}

const DEFAULT_MODEL = 'claude-haiku-4-5';
const USD_TO_INR = Number(process.env.AI_USD_TO_INR) || 88;

module.exports = { pilotIncludesClient, pilotAllows, platformKeyAllowed, DEFAULT_MODEL, USD_TO_INR };
