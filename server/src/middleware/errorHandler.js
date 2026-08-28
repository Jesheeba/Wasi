const { ZodError } = require('zod');

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// Readable strings, not raw ZodIssue objects — every other validation
// failure in this app returns {error, details: [string, ...]} (e.g.
// templateParams.js's errors), and the frontend's toast only surfaces
// details when every entry is a string (app.js's create-template submit
// handler, in particular) — issue objects silently fell back to the
// generic "Validation failed" with no indication of what actually failed
// or where. Shared with middleware/apiV1ErrorHandler.js so both the
// app-wide shape and the Hub API v1 shape describe the same failures the
// same way.
function formatZodIssues(err) {
  return err.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation failed', details: formatZodIssues(err) });
  }

  if (err && err.code === '23505') {
    return res.status(409).json({ error: 'Conflict', detail: err.detail });
  }

  if (err && err.code === '23503') {
    return res.status(400).json({ error: 'Invalid reference', detail: err.detail });
  }

  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { notFoundHandler, errorHandler, formatZodIssues };
