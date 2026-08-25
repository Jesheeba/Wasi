// Structured JSON logging (pino) — replaces plain console.error/log/warn
// across the infra/failure paths so log lines are machine-parseable
// (severity, structured fields) instead of freeform strings. See
// GAP_FIX_PLAN.md Phase B1.
//
// One process-wide logger, no per-request child loggers — this app has no
// request-id middleware yet, and the call sites this replaces are almost
// entirely background-runner/infra code, not per-request handlers. Where a
// log line names a grep-able tag (e.g. "metaWebhook FAILURE"), that literal
// string is kept in the message so existing grep/alert tooling built around
// it (wasi-build-plan.md §6.1) keeps working unchanged.
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

module.exports = logger;
