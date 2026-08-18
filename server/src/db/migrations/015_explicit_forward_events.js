// Makes forward-event selection explicit per subscription, for both
// forward targets (build plan Phase 5 follow-up). The commit that unified
// client_webhooks onto the same durable queue as wabas.forward_to_url also
// widened client_webhooks from message.received-only to all three event
// types — a real contract change for existing subscribers, made without
// asking. Checked live against the deployed database first: zero rows in
// client_webhooks and zero wabas with forward_to_url set, so nothing was
// actually broken by it — but "nobody's subscribed yet" is exactly the
// window to fix this properly rather than ship a default that could
// surprise the first real subscriber.
//
// Both events columns are required, not defaulted — a subscription that
// doesn't say which events it wants isn't "implicitly all of them," it's
// invalid. client_webhooks.events is NOT NULL outright (a row only exists
// once a client has configured a webhook, so "row exists" already implies
// "some events are wanted"). wabas.forward_events is nullable at the
// column level, matching forward_to_url/forward_secret's own nullability
// (forwarding is optional per waba), but a CHECK enforces that whenever
// forward_to_url is set, forward_events must be too — you cannot configure
// a target URL without also declaring what it receives.
//
// Both CHECKs validate every array element is one of the three known event
// types using `<@` (subset-of) against a literal built from
// utils/webhookEvents.js's WEBHOOK_EVENT_TYPES, so the DB constraint and
// the zod validation in validate.js can't drift apart.
const { WEBHOOK_EVENT_TYPES } = require('../../utils/webhookEvents');

const EVENT_TYPES_ARRAY_LITERAL = `array[${WEBHOOK_EVENT_TYPES.map((e) => `'${e}'`).join(', ')}]::text[]`;

exports.up = (pgm) => {
  pgm.sql(`
    alter table client_webhooks
      add column events text[] not null default '{}',
      add constraint client_webhooks_events_known_check check (events <@ ${EVENT_TYPES_ARRAY_LITERAL}),
      add constraint client_webhooks_events_nonempty_check check (cardinality(events) > 0)
  `);
  // Table is empty in every environment this has been deployed to (checked
  // live), so the temporary default above never actually backfills a real
  // row into an implicit "all events" state — it exists only so the
  // ADD COLUMN + ADD CONSTRAINT can run in one statement against Postgres's
  // own NOT NULL evaluation order. Dropped immediately: from here on,
  // omitting events on a new row is a real error, not a default.
  pgm.sql(`alter table client_webhooks alter column events drop default`);

  pgm.sql(`
    alter table wabas
      add column forward_events text[],
      add constraint wabas_forward_events_known_check check (forward_events <@ ${EVENT_TYPES_ARRAY_LITERAL}),
      add constraint wabas_forward_config_complete_check check (
        (forward_to_url is null and forward_events is null)
        or (forward_to_url is not null and forward_events is not null and cardinality(forward_events) > 0)
      )
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    alter table wabas
      drop constraint wabas_forward_config_complete_check,
      drop constraint wabas_forward_events_known_check,
      drop column forward_events
  `);
  pgm.sql(`
    alter table client_webhooks
      drop constraint client_webhooks_events_nonempty_check,
      drop constraint client_webhooks_events_known_check,
      drop column events
  `);
};
