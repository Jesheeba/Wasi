require('dotenv').config();
const { createApp } = require('./app');
const { getAlertingConfigStatus } = require('./utils/alertingConfig');
const broadcastRunner = require('./services/broadcastRunner');
const forwardRunner = require('./services/forwardRunner');
const alertRunner = require('./services/alertRunner');
const flowRunner = require('./services/flowRunner');
const metaTemplateLibraryRefreshRunner = require('./services/metaTemplateLibraryRefreshRunner');
const paymentReminderRunner = require('./services/paymentReminderRunner');
const messagingTierRefreshRunner = require('./services/messagingTierRefreshRunner');
const sendabilityMonitorRunner = require('./services/sendabilityMonitorRunner');

// Defense-in-depth, not a replacement for fixing specific gaps (see
// db/pool.js and broadcastRunner.js's own listeners for the two confirmed
// causes found live during Phase 2 verification). This is the backstop for
// whatever the *next* missed .catch() or unlistened emitter turns out to
// be — Node's default behavior for both of these, with no listener, is to
// crash the process outright.
//
// unhandledRejection: safe to just log and keep running — a rejected
// promise doesn't leave the process in the kind of undefined state a
// synchronous throw does.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION (process kept alive):', reason);
});

// uncaughtException: Node's own docs are explicit that continuing after one
// of these is unsafe — the process may be in a corrupted state in ways
// smaller than a full crash but worse than nothing. Log with full detail,
// then exit deliberately rather than trying to limp on. In production
// (`npm start`, no --watch) Render's process supervisor restarts an exited
// process; locally (`npm run dev`, --watch) a crash still requires a file
// change to restart, same as before — this handler doesn't change that
// local-dev behavior, only makes what happened loggable before the exit.
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (exiting):', err);
  process.exit(1);
});

// Confirmed real (2026-09-22, direct question): production has none of
// RESEND_API_KEY/ALERT_EMAIL_TO/ALERT_WHATSAPP_TO/ALERT_WABA_ID set — every
// ops alert this app has ever raised has silently gone nowhere but the
// console. This was invisible because every degrade-gracefully code path
// (emailService.js, alertNotifier.js) logs a "would have sent" line and
// moves on, exactly as designed for local dev, but nothing surfaced that
// same condition anywhere a deployed operator would actually see it. This
// startup check and the matching admin Health Monitor banner
// (GET /api/admin/alerting-status, alertingConfig.js) close that — a missing
// var is now a loud boot-time log line, not something only discoverable by
// reading server logs during an actual incident.
function logAlertingConfigWarnings() {
  const status = getAlertingConfigStatus();
  if (!status.resendConfigured) {
    console.warn('[startup] RESEND_API_KEY is not set — password reset, email verification, admin invites, AND ops alert emails will only log to console, never actually send.');
  }
  if (!status.emailConfigured) {
    console.warn('[startup] ALERT_EMAIL_TO is not set — ops alerts have no email recipient and will only log to console.');
  }
  if (!status.whatsappConfigured) {
    console.warn('[startup] ALERT_WHATSAPP_TO/ALERT_WABA_ID are not both set — WhatsApp ops alerts are disabled (email-only, if that\'s configured).');
  }
}

const port = process.env.PORT || 4000;
const app = createApp();

app.listen(port, () => {
  console.log(`wasi-crm-server listening on http://localhost:${port}`);
  logAlertingConfigWarnings();
  broadcastRunner.start();
  forwardRunner.start();
  alertRunner.start();
  flowRunner.start();
  metaTemplateLibraryRefreshRunner.start();
  paymentReminderRunner.start();
  messagingTierRefreshRunner.start();
  sendabilityMonitorRunner.start();
});
