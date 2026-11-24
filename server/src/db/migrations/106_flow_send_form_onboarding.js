// Two small widenings (build-docs/features/whatsapp-flows.md, "Send form" step):
// - flow_nodes.type gains 'send_form': a Bot Flow step that sends one of the
//   client's WhatsApp Forms and waits for it to be submitted ('always' edge),
//   with the same optional 'timeout' edge capture_reply has.
// - flow_events.event_type gains 'form_submitted' (same precedent as 067's
//   'reply_captured').
// - whatsapp_flows.kind gains 'onboarding' (a sign-up form: business, contact,
//   plan, current WhatsApp tool).
// No new columns, so no grant changes.
const NODE_TYPES = "'send_text', 'send_interactive_buttons', 'send_template', 'delay', 'action', 'end', 'capture_reply'";
const EVENT_TYPES = "'entered', 'message_sent', 'button_clicked', 'timed_out', 'unmatched_input', 'superseded', 'stalled', 'completed', 'reply_captured'";
const KINDS = "'lead', 'booking', 'survey', 'booking_live'";

function setChecks(pgm, extraNode, extraEvent, extraKind) {
  pgm.dropConstraint('flow_nodes', 'flow_nodes_type_check');
  pgm.addConstraint('flow_nodes', 'flow_nodes_type_check', { check: `type in (${NODE_TYPES}${extraNode})` });
  pgm.dropConstraint('flow_events', 'flow_events_event_type_check');
  pgm.addConstraint('flow_events', 'flow_events_event_type_check', { check: `event_type in (${EVENT_TYPES}${extraEvent})` });
  pgm.dropConstraint('whatsapp_flows', 'whatsapp_flows_kind_check');
  pgm.addConstraint('whatsapp_flows', 'whatsapp_flows_kind_check', { check: `kind in (${KINDS}${extraKind})` });
}

exports.up = (pgm) => setChecks(pgm, ", 'send_form'", ", 'form_submitted'", ", 'onboarding'");

exports.down = (pgm) => {
  // Refuse rather than silently break rows a client created.
  pgm.sql(`do $$ begin
    if exists (select 1 from flow_nodes where type = 'send_form') or exists (select 1 from whatsapp_flows where kind = 'onboarding')
      or exists (select 1 from flow_events where event_type = 'form_submitted') then
      raise exception 'Cannot roll back 106: send_form steps, onboarding forms or form_submitted events exist';
    end if; end $$;`);
  setChecks(pgm, '', '', '');
};
