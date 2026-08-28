// Shared Hub API v1 error-response shape — wasi-master-plan.md §8.6:
// { error: { code, message, ...extra } } on every /api/v1/* response,
// replacing the five inconsistent ad-hoc shapes routes/apiV1*.js used to
// hand-roll individually. `code` is a stable machine-readable string (safe
// for a caller, including the MCP server, to branch on); `message` is the
// human-readable text already used in the response before this change.
// `extra` carries optional per-error context (metaError, details) nested
// under `error` rather than as sibling top-level fields, so the whole
// response stays a single consistent shape to parse.
function sendApiError(res, status, code, message, extra) {
  res.status(status).json({ error: { code, message, ...extra } });
}

module.exports = { sendApiError };
