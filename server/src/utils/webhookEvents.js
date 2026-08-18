// Single source of truth for the event types a forward subscription
// (client_webhooks or wabas.forward_events) can register for — used by
// both the zod schemas (validate.js) and the DB CHECK constraints
// (migration 015_explicit_forward_events.js builds its SQL from this same
// array) so the two can't drift apart.
const WEBHOOK_EVENT_TYPES = ['message.received', 'message_template_status_update', 'account_update'];

module.exports = { WEBHOOK_EVENT_TYPES };
