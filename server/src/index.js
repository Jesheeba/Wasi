require('dotenv').config();
const { createApp } = require('./app');
const broadcastRunner = require('./services/broadcastRunner');
const forwardRunner = require('./services/forwardRunner');
const alertRunner = require('./services/alertRunner');
const flowRunner = require('./services/flowRunner');
const logger = require('./utils/logger');
const { initErrorTracking, captureException, flush } = require('./utils/errorTracking');

initErrorTracking();

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
  logger.error({ err: reason }, 'UNHANDLED REJECTION (process kept alive)');
  captureException(reason);
});

// uncaughtException: Node's own docs are explicit that continuing after one
// of these is unsafe — the process may be in a corrupted state in ways
// smaller than a full crash but worse than nothing. Log with full detail,
// then exit deliberately rather than trying to limp on. In production
// (`npm start`, no --watch) Render's process supervisor restarts an exited
// process; locally (`npm run dev`, --watch) a crash still requires a file
// change to restart, same as before — this handler doesn't change that
// local-dev behavior, only makes what happened loggable (and, if
// SENTRY_DSN is set, reportable) before the exit.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'UNCAUGHT EXCEPTION (exiting)');
  captureException(err);
  // Wait for the Sentry delivery before exiting — this is exactly the
  // crash that report matters most for, and a same-tick process.exit()
  // would otherwise race the network send and drop it.
  flush().finally(() => process.exit(1));
});

const port = process.env.PORT || 4000;
const app = createApp();

app.listen(port, () => {
  logger.info(`wasi-crm-server listening on http://localhost:${port}`);
  broadcastRunner.start();
  forwardRunner.start();
  alertRunner.start();
  flowRunner.start();
});
