// flow_events.event_type (migration 023) didn't anticipate one real case
// discovered while building flowEngine.js (Stage 3): a mid-flow contact
// sends something that matches no outgoing edge on their current node. That
// isn't a failure ('stalled') and isn't a race ('superseded') — the flow
// state is untouched on purpose (see migration 023's module comment: a
// non-flow automation_rules keyword like "agent"/"help" should still be
// able to interrupt a flow), but it's still worth its own label for
// debugging "why didn't this contact's flow move." Same fix shape as
// migration 016_widen_template_status_vocabulary.js: the check was too
// narrow for a real case the application code already needed to record.
exports.up = (pgm) => {
  pgm.dropConstraint('flow_events', 'flow_events_event_type_check');
  pgm.addConstraint('flow_events', 'flow_events_event_type_check', {
    check: "event_type in ('entered', 'message_sent', 'button_clicked', 'timed_out', 'unmatched_input', 'superseded', 'stalled', 'completed')",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('flow_events', 'flow_events_event_type_check');
  pgm.addConstraint('flow_events', 'flow_events_event_type_check', {
    check: "event_type in ('entered', 'message_sent', 'button_clicked', 'timed_out', 'superseded', 'stalled', 'completed')",
  });
};
