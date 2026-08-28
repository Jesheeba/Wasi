// Interim auth (build plan Phase 4 Phase 0 decision): the client's own
// existing Wasi Hub API key, pasted directly into this field — the same
// Bearer key mechanism every other Hub API consumer already uses (Postman,
// mcp-server, custom scripts). No dependency on the OAuth "Connected Apps"
// layer (wasi-master-plan.md §8.6), which the master plan's own build order
// sequences AFTER Zapier and frames as needed only when moving from
// private/beta to certified public distribution — not to ship at all.
//
// The key is never stored by Wasi's servers on the client's behalf; it's
// the client's own already-revocable key (server/src/routes/apiKeys.js),
// generated via Wasi's Settings > Developer page and shown exactly once.
const testAuth = (z, bundle) =>
  z.request({ url: '/api/v1/account' }).then((response) => response.json);

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'base_url',
      label: 'Wasi Base URL',
      type: 'string',
      required: true,
      helpText: 'Your Wasi instance\'s base URL, e.g. https://your-wasi-domain.example (no trailing slash).',
    },
    {
      key: 'api_key',
      label: 'API Key',
      type: 'password',
      required: true,
      helpText: 'Paste your Wasi Hub API key here — generate one from Settings > Developer in your Wasi CRM (name it "Zapier" so it\'s easy to find later). This is the same key mechanism every other Wasi Hub API integration uses; only you can see or revoke it.',
    },
  ],
  test: testAuth,
  connectionLabel: 'Wasi ({{bundle.inputData.client_id}})',
};
