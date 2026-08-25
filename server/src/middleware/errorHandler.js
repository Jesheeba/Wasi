const { ZodError } = require('zod');
const logger = require('../utils/logger');
const { captureException } = require('../utils/errorTracking');

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    // Readable strings, not raw ZodIssue objects — every other validation
    // failure in this app returns {error, details: [string, ...]} (e.g.
    // templateParams.js's errors), and the frontend's toast only surfaces
    // details when every entry is a string (app.js's create-template submit
    // handler, in particular) — issue objects silently fell back to the
    // generic "Validation failed" with no indication of what actually
    // failed or where.
    const details = err.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return res.status(400).json({ error: 'Validation failed', details });
  }

  if (err && err.code === '23505') {
    return res.status(409).json({ error: 'Conflict', detail: err.detail });
  }

  if (err && err.code === '23503') {
    return res.status(400).json({ error: 'Invalid reference', detail: err.detail });
  }

  // Only the genuinely-unexpected case reaches here — ZodError, unique-
  // constraint (23505), and FK-violation (23503) are all handled above as
  // ordinary, expected failure modes, not bugs. Everything else is a real
  // exception worth a stack trace and, if configured, a Sentry report.
  logger.error({ err }, 'unhandled route error');
  captureException(err);
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { notFoundHandler, errorHandler };
