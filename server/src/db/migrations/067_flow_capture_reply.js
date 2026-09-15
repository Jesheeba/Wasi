// Adds a new flow node type, 'capture_reply' — sends a prompt, waits for the
// contact's next inbound message (same waiting mechanism runToRest already
// uses for send_interactive_buttons — see flowEngine.js), and stores
// whatever they sent as a contact_attribute_value. No new flow_edges
// condition_type is needed: it uses the existing 'always' (continue after
// capturing) and optional 'timeout' (no reply in time), exactly like
// send_interactive_buttons already does.
//
// 'reply_captured' is a new flow_events.event_type, mirroring migration
// 024_widen_flow_event_types.js's precedent — a captured reply is neither a
// button click nor a plain auto-advance, so it deserves its own label for
// debugging "what did this contact's flow actually record."
exports.up = (pgm) => {
  pgm.dropConstraint('flow_nodes', 'flow_nodes_type_check');
  pgm.addConstraint('flow_nodes', 'flow_nodes_type_check', {
    check: "type in ('send_text', 'send_interactive_buttons', 'send_template', 'delay', 'action', 'end', 'capture_reply')",
  });

  pgm.dropConstraint('flow_events', 'flow_events_event_type_check');
  pgm.addConstraint('flow_events', 'flow_events_event_type_check', {
    check: "event_type in ('entered', 'message_sent', 'button_clicked', 'timed_out', 'unmatched_input', 'superseded', 'stalled', 'completed', 'reply_captured')",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('flow_events', 'flow_events_event_type_check');
  pgm.addConstraint('flow_events', 'flow_events_event_type_check', {
    check: "event_type in ('entered', 'message_sent', 'button_clicked', 'timed_out', 'unmatched_input', 'superseded', 'stalled', 'completed')",
  });

  pgm.dropConstraint('flow_nodes', 'flow_nodes_type_check');
  pgm.addConstraint('flow_nodes', 'flow_nodes_type_check', {
    check: "type in ('send_text', 'send_interactive_buttons', 'send_template', 'delay', 'action', 'end')",
  });
};
