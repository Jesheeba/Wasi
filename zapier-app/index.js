const zapier = require('zapier-platform-core');
const authentication = require('./authentication');
const newMessageReceivedTrigger = require('./triggers/newMessageReceived');
const sendMessageCreate = require('./creates/sendMessage');
const packageJson = require('./package.json');

// Injects Authorization + resolves every request URL against the client's
// own base_url in exactly one place — no trigger/create builds its own
// fetch call, same discipline as mcp-server/src/hubClient.js's hubRequest.
const addAuthHeader = (request, z, bundle) => {
  request.headers = { ...request.headers, Authorization: `Bearer ${bundle.authData.api_key}` };
  if (bundle.authData.base_url && !/^https?:\/\//.test(request.url)) {
    request.url = `${bundle.authData.base_url.replace(/\/+$/, '')}${request.url}`;
  }
  return request;
};

// Hub API v1's error shape is { error: { code, message, ...extra } }
// (server/src/utils/apiError.js) — normalized into a real thrown error here,
// the one place every trigger/create's response passes through, so none of
// them need to parse this shape themselves.
const handleErrors = (response, z, bundle) => {
  if (response.status >= 400) {
    const body = response.json || {};
    const err = body.error && typeof body.error === 'object' ? body.error : {};
    throw new z.errors.Error(
      err.message || `Wasi Hub API request failed (HTTP ${response.status})`,
      err.code || 'unknown_error',
      response.status
    );
  }
  return response;
};

module.exports = {
  version: packageJson.version,
  platformVersion: zapier.version,

  authentication,

  beforeRequest: [addAuthHeader],
  afterResponse: [handleErrors],

  triggers: {
    [newMessageReceivedTrigger.key]: newMessageReceivedTrigger,
  },
  creates: {
    [sendMessageCreate.key]: sendMessageCreate,
  },
};
