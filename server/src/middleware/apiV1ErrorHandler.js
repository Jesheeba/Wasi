// Hub API v1's own 404 + error-handling pair, mounted in app.js right after
// the five /api/v1/* routers and before the app-wide notFoundHandler/
// errorHandler (middleware/errorHandler.js) — those stay untouched and keep
// serving admin/marketing/the client CRM app's existing {error: 'string'}
// shape. This pair is what makes {error: {code, message}} (wasi-master-plan.md
// §8.6) the one consistent shape across every Hub API v1 endpoint, including
// requests that never reach a route handler (unmatched path) or that throw
// (Zod validation, Postgres constraint violations, an uncaught error) rather
// than returning a hand-written response — the five apiV1*.js route files
// only need sendApiError() (utils/apiError.js) for their own known failure
// cases; everything else funnels through here.
const { ZodError } = require('zod');
const { formatZodIssues } = require('./errorHandler');
const { sendApiError } = require('../utils/apiError');

function apiV1NotFoundHandler(req, res) {
  sendApiError(res, 404, 'not_found', 'Not found.');
}

// eslint-disable-next-line no-unused-vars
function apiV1ErrorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return sendApiError(res, 400, 'validation_failed', 'Request validation failed.', {
      details: formatZodIssues(err),
    });
  }

  if (err && err.code === '23505') {
    return sendApiError(res, 409, 'conflict', 'This request conflicts with an existing record.', {
      detail: err.detail,
    });
  }

  if (err && err.code === '23503') {
    return sendApiError(res, 400, 'invalid_reference', 'This request references a record that does not exist.', {
      detail: err.detail,
    });
  }

  console.error(err);
  sendApiError(res, 500, 'internal_error', 'Internal server error.');
}

module.exports = { apiV1NotFoundHandler, apiV1ErrorHandler };
