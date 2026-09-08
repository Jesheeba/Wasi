const { ZodError } = require('zod');
const multer = require('multer');

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
  // multer's upload middleware (contacts.js, contactLists.js, templates.js,
  // onboarding.js all use it) throws synchronously and calls next(err)
  // directly, bypassing asyncHandler — it lands here uncaught, and without
  // this check fell all the way through to the generic 500 below, even
  // though every MulterError (a file over the configured size limit, an
  // unexpected field name, etc.) is a client mistake, never a server bug.
  // Fixed centrally rather than per-route, matching this file's own
  // ZodError handling above and this codebase's established
  // one-shared-helper convention for a class of error every route sharing
  // it needs handled the same way.
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large — it exceeds this upload\'s size limit.' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }

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
