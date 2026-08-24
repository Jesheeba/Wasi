// webhookEvents.js's WEBHOOK_EVENT_TYPES gained 'message.status' (metaWebhook.js's
// handleStatuses now forwards the sent/delivered/read/failed lifecycle, which it
// never did before — see that file's module comment). The CHECK constraints added
// in migration 015_explicit_forward_events.js were built from the array as it
// stood then, so they don't retroactively pick up a new element just because the
// JS source did — same fix shape as migration 024_widen_flow_event_types.js.
const { WEBHOOK_EVENT_TYPES } = require('../../utils/webhookEvents');

const EVENT_TYPES_ARRAY_LITERAL = `array[${WEBHOOK_EVENT_TYPES.map((e) => `'${e}'`).join(', ')}]::text[]`;
const OLD_EVENT_TYPES_ARRAY_LITERAL = "array['message.received', 'message_template_status_update', 'account_update']::text[]";

exports.up = (pgm) => {
  pgm.dropConstraint('client_webhooks', 'client_webhooks_events_known_check');
  pgm.addConstraint('client_webhooks', 'client_webhooks_events_known_check', {
    check: `events <@ ${EVENT_TYPES_ARRAY_LITERAL}`,
  });

  pgm.dropConstraint('wabas', 'wabas_forward_events_known_check');
  pgm.addConstraint('wabas', 'wabas_forward_events_known_check', {
    check: `forward_events <@ ${EVENT_TYPES_ARRAY_LITERAL}`,
  });
};

exports.down = async (pgm) => {
  // Re-adding the narrower CHECK below validates it against every existing
  // row immediately (no NOT VALID escape hatch — deliberately: a silently
  // NOT VALID constraint would let already-invalid rows sit unnoticed,
  // which is worse than a loud failure here). So any waba or client_webhook
  // still subscribed to 'message.status' would make that ADD CONSTRAINT
  // fail with a raw, uninformative Postgres error. Check first and fail
  // loudly with the actual client_ids instead, so the operator knows
  // exactly what to unsubscribe (via the admin UI's forwarding config)
  // before retrying the rollback.
  const wabaRows = await pgm.db.select(
    `select client_id from wabas where forward_events @> array['message.status']::text[]`
  );
  const clientWebhookRows = await pgm.db.select(
    `select client_id from client_webhooks where events @> array['message.status']::text[]`
  );
  const blockingClientIds = Array.from(
    new Set([...wabaRows, ...clientWebhookRows].map((r) => r.client_id))
  );
  if (blockingClientIds.length > 0) {
    throw new Error(
      `Cannot roll back 032_widen_forward_events: message.status forwarding is ` +
      `still enabled for client_id(s) ${blockingClientIds.join(', ')}. Disable ` +
      `message.status in the admin UI's CRM Inbound Forwarding config for each ` +
      `of these clients first, then retry this rollback.`
    );
  }

  pgm.dropConstraint('wabas', 'wabas_forward_events_known_check');
  pgm.addConstraint('wabas', 'wabas_forward_events_known_check', {
    check: `forward_events <@ ${OLD_EVENT_TYPES_ARRAY_LITERAL}`,
  });

  pgm.dropConstraint('client_webhooks', 'client_webhooks_events_known_check');
  pgm.addConstraint('client_webhooks', 'client_webhooks_events_known_check', {
    check: `events <@ ${OLD_EVENT_TYPES_ARRAY_LITERAL}`,
  });
};
