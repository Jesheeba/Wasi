// Mirrors app.js's FLOW_EDGE_TYPES_BY_NODE_TYPE / FLOW_EDGE_TYPE_LABELS /
// FLOW_NODE_TYPE_LABELS exactly — same reasoning as that file's own
// comment: the server re-validates on POST .../edges regardless, this only
// drives what the UI offers so a legal-but-wrong-looking option is never
// shown. Kept as a literal duplicate rather than a shared import — the two
// projects (this one and app.js) deliberately don't share a build step.
export const FLOW_EDGE_TYPES_BY_NODE_TYPE = {
  send_interactive_buttons: ['button_id', 'keyword', 'default', 'timeout'],
  delay: ['always'],
  send_text: ['always'],
  send_template: ['always'],
  action: ['always'],
  end: [],
};

export const FLOW_EDGE_TYPE_LABELS = {
  always: 'Always',
  button_id: 'Button tapped',
  keyword: 'Keyword match',
  default: 'Default (fallback)',
  timeout: 'Timeout',
};

// Same palette as the read-only canvas's flow-edge-<condition_type> CSS
// classes (index.css) — kept visually identical across both editors.
export const CONDITION_COLORS = {
  button_id: '#1e6e5a',
  keyword: '#2e5f8a',
  default: '#9a6a1f',
  timeout: '#a4402f',
  always: '#8a8578',
};

export const NODE_TYPE_LABELS = {
  send_text: 'Send Text',
  send_interactive_buttons: 'Send Buttons',
  send_template: 'Send Template',
  delay: 'Delay',
  action: 'Action',
  end: 'End',
};

// Palette entries — one per creatable node shape. 'action' nodes carry a
// config.kind (assign_tag/set_opt_in/human_handoff, see flowEngine.js's
// executeAction); the palette exposes each kind as its own button so
// picking one also fixes the kind, rather than a node-type dropdown
// followed by a second kind dropdown.
export const PALETTE_ITEMS = [
  { paletteId: 'send_text', type: 'send_text', label: 'Send Text', defaultConfig: { body: '' } },
  { paletteId: 'send_interactive_buttons', type: 'send_interactive_buttons', label: 'Send Buttons', defaultConfig: { body: '', buttons: [] } },
  { paletteId: 'send_template', type: 'send_template', label: 'Send Template', defaultConfig: { templateName: '' } },
  { paletteId: 'delay', type: 'delay', label: 'Delay', defaultConfig: { duration_minutes: 5 } },
  { paletteId: 'assign_tag', type: 'action', label: 'Assign Tag', defaultConfig: { kind: 'assign_tag', tag_id: '' } },
  { paletteId: 'set_opt_in', type: 'action', label: 'Set Opt-In', defaultConfig: { kind: 'set_opt_in', opt_in_event: 'opted_in' } },
  { paletteId: 'human_handoff', type: 'action', label: 'Hand Off to Human', defaultConfig: { kind: 'human_handoff' } },
  { paletteId: 'end', type: 'end', label: 'End', defaultConfig: {} },
];

export function legalEdgeTypesFor(nodeType) {
  return FLOW_EDGE_TYPES_BY_NODE_TYPE[nodeType] || [];
}
