// Shared Hub API v1 error-response shape - wasi-master-plan.md §8.6:
// { error: { code, message, ...extra } } on every /api/v1/* response,
// replacing the five inconsistent ad-hoc shapes routes/apiV1*.js used to
// hand-roll individually. `code` is a stable machine-readable string (safe
// for a caller, including the MCP server, to branch on); `message` is the
// human-readable text already used in the response before this change.
// `extra` carries optional per-error context (metaError, details) nested
// under `error` rather than as sibling top-level fields, so the whole
// response stays a single consistent shape to parse.
//
// Every refusal of an authenticated API-key request is also logged
// (apiRejectionsRepo, build-docs/features/hub-api-rejection-log.md), so
// "why did n8n fail?" can be answered for refusals that never reached Meta.
// Unauthenticated requests (bad key) have no client to log against.
function sendApiError(res, status, code, message, extra) {
  res.status(status).json({ error: { code, message, ...extra } });
  const req = res.req;
  if (req && req.clientId && req.apiKeyId) {
    // Lazy require: keeps this module free of a DB dependency for callers
    // (and tests) that never log anything.
    // eslint-disable-next-line global-require
    require('../repositories/apiRejectionsRepo').record({
      clientId: req.clientId, apiKeyId: req.apiKeyId,
      method: req.method, path: req.originalUrl || req.url, status, code, message,
    });
  }
}

module.exports = { sendApiError };
