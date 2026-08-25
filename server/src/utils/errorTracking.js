// Optional code-level exception tracking (Sentry), gated on SENTRY_DSN —
// same degrade-gracefully pattern as every other optional integration in
// this codebase (RESEND_API_KEY, META_APP_ID, etc.): absent env var means
// this quietly no-ops, never a startup failure. See GAP_FIX_PLAN.md Phase B2.
//
// Deliberately distinct from alertRunner.js/alertNotifier.js: alertRunner
// detects business-condition *symptoms* visible in DB state (a stale
// webhook timestamp, a non-green quality rating) on a 5-minute poll — it
// has no visibility into a code-level bug that never touches those tables.
// This captures the exception itself, with a stack trace, at the moment it
// happens.
let Sentry = null;

function initErrorTracking() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry = require('@sentry/node');
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Error tracking only — this app has no need for Sentry's performance
    // tracing product, and sampling transactions would just add overhead.
    tracesSampleRate: 0,
  });
}

function captureException(err) {
  if (!Sentry) return;
  Sentry.captureException(err);
}

// Waits for any in-flight Sentry delivery to actually leave the process —
// needed before process.exit(1) on an uncaughtException, where an
// immediate exit would otherwise race the network send and drop the report
// that mattered most (the one for the crash that just took the process down).
async function flush(timeoutMs = 2000) {
  if (!Sentry) return;
  await Sentry.close(timeoutMs);
}

module.exports = { initErrorTracking, captureException, flush };
