// WhatsApp Flows ("Forms") - the fixed set of form kinds Wasi authors
// (owner decision 2026-11-23: lead / booking / survey with editable labels
// and options, not a visual designer). build-docs/features/whatsapp-flows.md.
//
// Uses only components Meta documents with confirmed props (TextInput,
// Dropdown, DatePicker, Footer) and the limits from Meta's components
// reference: TextInput label <= 20, DatePicker label <= 40, Dropdown option
// title <= 30 and 1-200 options, Footer label <= 35. Flow JSON version is
// kept in one constant so a future freeze only needs one change.
const FLOW_JSON_VERSION = '7.3';

// The flow_token Wasi sends carries our own form id, because Meta's
// nfm_reply webhook does not include the flow id.
const TOKEN_PREFIX = 'wasi_flow:';
const makeFlowToken = (flowId) => `${TOKEN_PREFIX}${flowId}`;
function flowIdFromToken(token) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
  const id = token.slice(TOKEN_PREFIX.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

// type: text | email | date | choice. maxLabel follows Meta's per-component cap.
const KINDS = {
  lead: {
    label: 'Lead form',
    category: 'LEAD_GENERATION',
    screen: 'LEAD_FORM',
    defaults: {
      title: 'Get in touch',
      submitLabel: 'Submit',
      fields: {
        name: { type: 'text', label: 'Full name', required: true },
        email: { type: 'email', label: 'Email', required: false },
        interest: { type: 'choice', label: 'Interested in', required: true, options: ['Product A', 'Product B', 'Something else'] },
        notes: { type: 'text', label: 'Anything else?', required: false },
      },
    },
  },
  booking: {
    label: 'Appointment booking',
    category: 'APPOINTMENT_BOOKING',
    screen: 'BOOKING',
    defaults: {
      title: 'Book an appointment',
      submitLabel: 'Request booking',
      fields: {
        name: { type: 'text', label: 'Full name', required: true },
        service: { type: 'choice', label: 'Service', required: true, options: ['Consultation', 'Demo', 'Follow-up'] },
        date: { type: 'date', label: 'Preferred date', required: true },
        slot: { type: 'choice', label: 'Preferred time', required: true, options: ['Morning (9-12)', 'Afternoon (12-4)', 'Evening (4-7)'] },
      },
    },
  },
  survey: {
    label: 'Feedback survey',
    category: 'SURVEY',
    screen: 'SURVEY',
    defaults: {
      title: 'Quick feedback',
      submitLabel: 'Send feedback',
      fields: {
        rating: { type: 'choice', label: 'Your rating', required: true, options: ['5 - Excellent', '4 - Good', '3 - Okay', '2 - Poor', '1 - Very poor'] },
        recommend: { type: 'choice', label: 'Would recommend us?', required: true, options: ['Yes', 'Maybe', 'No'] },
        comments: { type: 'text', label: 'Comments', required: false },
      },
    },
  },
};

const LIMITS = { title: 30, submitLabel: 35, text: 20, email: 20, choice: 20, date: 40, option: 30, maxOptions: 200 };

// Merges a client's edits onto the kind's defaults. Only labels, options and
// required may change; field keys and types are fixed per kind. Returns
// { config, errors } - errors are client-readable strings.
function normalizeConfig(kind, input = {}) {
  const def = KINDS[kind];
  if (!def) return { config: null, errors: [`Unknown form type "${kind}".`] };
  const errors = [];
  const str = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  const config = {
    title: str(input.title, def.defaults.title),
    submitLabel: str(input.submitLabel, def.defaults.submitLabel),
    fields: {},
  };
  if (config.title.length > LIMITS.title) errors.push(`Form title must be ${LIMITS.title} characters or fewer.`);
  if (config.submitLabel.length > LIMITS.submitLabel) errors.push(`Button text must be ${LIMITS.submitLabel} characters or fewer.`);

  for (const [key, base] of Object.entries(def.defaults.fields)) {
    const edit = input.fields?.[key] || {};
    const field = { type: base.type, label: str(edit.label, base.label), required: typeof edit.required === 'boolean' ? edit.required : base.required };
    if (field.label.length > LIMITS[base.type]) errors.push(`"${field.label}" is too long: labels can be ${LIMITS[base.type]} characters at most.`);
    if (base.type === 'choice') {
      const options = Array.isArray(edit.options) ? edit.options.map((o) => String(o).trim()).filter(Boolean) : base.options;
      if (!options.length) errors.push(`"${field.label}" needs at least one option.`);
      if (options.length > LIMITS.maxOptions) errors.push(`"${field.label}" can have ${LIMITS.maxOptions} options at most.`);
      if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) errors.push(`"${field.label}" has duplicate options.`);
      for (const o of options) if (o.length > LIMITS.option) errors.push(`Option "${o}" is too long: ${LIMITS.option} characters at most.`);
      field.options = options;
    }
    config.fields[key] = field;
  }
  return { config, errors };
}

function buildFlowJson(kind, config) {
  const def = KINDS[kind];
  const children = [];
  const payload = {};
  for (const [key, f] of Object.entries(config.fields)) {
    if (f.type === 'choice') {
      children.push({
        type: 'Dropdown', name: key, label: f.label, required: f.required,
        'data-source': f.options.map((title, i) => ({ id: `opt_${i + 1}`, title })),
      });
    } else if (f.type === 'date') {
      children.push({ type: 'DatePicker', name: key, label: f.label, required: f.required });
    } else {
      children.push({ type: 'TextInput', name: key, label: f.label, 'input-type': f.type === 'email' ? 'email' : 'text', required: f.required });
    }
    payload[key] = `\${form.${key}}`;
  }
  children.push({ type: 'Footer', label: config.submitLabel, 'on-click-action': { name: 'complete', payload } });
  return {
    version: FLOW_JSON_VERSION,
    screens: [{ id: def.screen, title: config.title, terminal: true, success: true, layout: { type: 'SingleColumnLayout', children } }],
  };
}

// Turns a parsed nfm_reply response_json into readable label/value pairs.
// Dropdown answers arrive as option ids (opt_N); map them back to the text.
function describeResponse(flow, response) {
  const fields = flow?.config?.fields || {};
  const rows = [];
  // The form type's field order first: config and responses are stored as
  // jsonb, which reorders keys, so neither can be trusted for order.
  const order = Object.keys(KINDS[flow?.kind]?.defaults.fields || fields);
  const keys = [...new Set([...order, ...Object.keys(response || {})])];
  for (const key of keys) {
    if (!(key in (response || {}))) continue;
    const value = response[key];
    if (key === 'flow_token' || value === '' || value == null) continue;
    const f = fields[key];
    let shown = value;
    if (f?.type === 'choice' && typeof value === 'string') {
      const m = /^opt_(\d+)$/.exec(value);
      if (m && f.options[Number(m[1]) - 1]) shown = f.options[Number(m[1]) - 1];
    }
    rows.push({ key, label: f?.label || key, value: String(shown) });
  }
  return rows;
}

module.exports = { FLOW_JSON_VERSION, KINDS, LIMITS, normalizeConfig, buildFlowJson, describeResponse, makeFlowToken, flowIdFromToken };
