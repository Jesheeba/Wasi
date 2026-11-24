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
const liveBooking = require('./flowLiveBooking');

// The flow_token Wasi sends carries our own form id, because Meta's
// nfm_reply webhook does not include the flow id.
const TOKEN_PREFIX = 'wasi_flow:';
const makeFlowToken = (flowId, chatId) => `${TOKEN_PREFIX}${flowId}${chatId ? `:${chatId}` : ''}`;
function flowIdFromToken(token) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
  const id = token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 36);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}
// Live booking tokens carry the chat too: wasi_flow:<flowId>:<chatId>.
function chatIdFromToken(token) {
  const m = /^wasi_flow:[0-9a-f-]{36}:([0-9a-f-]{36})$/i.exec(token || '');
  return m ? m[1] : null;
}

// Question types a form can use, with Meta's limits (Flows components
// reference, checked 2026-11-24): TextInput/TextArea/Dropdown label <= 20,
// DatePicker label <= 40, RadioButtonsGroup/CheckboxGroup label content <= 30
// and 1-20 options, Dropdown 1-200 options, option title <= 30, 50
// components per screen (Wasi caps a form at MAX_FIELDS questions).
// build-docs/features/custom-forms.md.
const FIELD_TYPES = {
  text: { label: 'Short answer', component: 'TextInput', inputType: 'text', maxLabel: 20 },
  long_text: { label: 'Long answer', component: 'TextArea', maxLabel: 20 },
  email: { label: 'Email', component: 'TextInput', inputType: 'email', maxLabel: 20 },
  phone: { label: 'Phone number', component: 'TextInput', inputType: 'phone', maxLabel: 20 },
  number: { label: 'Number', component: 'TextInput', inputType: 'number', maxLabel: 20 },
  date: { label: 'Date', component: 'DatePicker', maxLabel: 40 },
  choice: { label: 'Dropdown', component: 'Dropdown', maxLabel: 20, maxOptions: 200 },
  radio: { label: 'Single choice', component: 'RadioButtonsGroup', maxLabel: 30, maxOptions: 20 },
  checkbox: { label: 'Multiple choice', component: 'CheckboxGroup', maxLabel: 30, maxOptions: 20 },
};
const MAX_FIELDS = 20;
const KEY_RE = /^[a-z][a-z0-9_]{0,29}$/;

// Templates. Their questions are only a starting point: config.fields is an
// editable ordered list (see fieldList). booking_live is the exception.
const KINDS = {
  custom: {
    label: 'Blank form',
    category: 'OTHER',
    screen: 'FORM',
    defaults: {
      title: 'Your details',
      submitLabel: 'Submit',
      fields: {
        name: { type: 'text', label: 'Full name', required: true },
      },
    },
  },

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
  // Sign-up form: the details needed to onboard a new business (written for
  // Wasi's own onboarding; any client can reword it for theirs).
  onboarding: {
    label: 'Business onboarding',
    category: 'SIGN_UP',
    screen: 'ONBOARDING',
    defaults: {
      title: 'Start with Wasi',
      submitLabel: 'Send details',
      fields: {
        business: { type: 'text', label: 'Business name', required: true },
        name: { type: 'text', label: 'Your name', required: true },
        email: { type: 'email', label: 'Email', required: true },
        industry: { type: 'choice', label: 'Industry', required: true, options: ['Education', 'Retail', 'E-commerce', 'Healthcare', 'Real estate', 'Services', 'Other'] },
        plan: { type: 'choice', label: 'Plan you want', required: true, options: ['Starter (₹999/month)', 'Growth (₹2,999/month)', 'Scale (₹7,999/month)', 'Not sure yet'] },
        provider: { type: 'choice', label: 'WhatsApp tool now', required: true, options: ['None - new to WhatsApp API', 'WhatsApp Business app', 'AiSensy', 'Wati', 'Interakt', 'Other provider'] },
        website: { type: 'text', label: 'Website (optional)', required: false },
      },
    },
  },
};

// booking_live (phase 2) is answered by Wasi's Flows endpoint with real free
// slots; its config and Flow JSON live in flowLiveBooking.js. `fields` here
// only gives the answer labels and order for describeResponse.
KINDS.booking_live = {
  label: 'Booking with live slots',
  category: 'APPOINTMENT_BOOKING',
  screen: 'DATE',
  endpoint: true,
  defaults: {
    ...liveBooking.DEFAULTS,
    fields: { name: { type: 'text', label: 'Name' }, date: { type: 'date', label: 'Date' }, slot: { type: 'text', label: 'Time' } },
  },
};

const LIMITS = { title: 30, submitLabel: 35, text: 20, email: 20, choice: 20, date: 40, option: 30, maxOptions: 200 };

// Merges a client's edits onto the kind's defaults. Only labels, options and
// required may change; field keys and types are fixed per kind. Returns
// { config, errors } - errors are client-readable strings.
function normalizeConfig(kind, input = {}) {
  if (kind === 'booking_live') return liveBooking.normalizeConfig(input);
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

  // The editor sends an ordered list of questions. Older callers send
  // per-key edits onto the template's questions; both end up as the list.
  const raw = Array.isArray(input.fields)
    ? input.fields
    : Object.entries(def.defaults.fields).map(([key, base]) => {
      const edit = input.fields?.[key] || {};
      return { ...base, key, label: edit.label ?? base.label, required: edit.required ?? base.required, options: edit.options ?? base.options };
    });
  if (!raw.length) errors.push('Add at least one question.');
  if (raw.length > MAX_FIELDS) errors.push(`A form can have ${MAX_FIELDS} questions at most.`);
  // Keep valid, unique keys (stored answers and contact-field mapping use
  // them); give the rest q1, q2, ...
  const taken = new Set();
  const kept = raw.map((f) => {
    const k = typeof f?.key === 'string' && KEY_RE.test(f.key) && !taken.has(f.key) ? f.key : null;
    if (k) taken.add(k);
    return k;
  });
  let n = 0;
  config.fields = raw.slice(0, MAX_FIELDS).map((f, i) => {
    const t = FIELD_TYPES[f?.type];
    if (!t) { errors.push(`Question ${i + 1} has an unknown type.`); return null; }
    let key = kept[i];
    while (!key) { const c = `q${++n}`; if (!taken.has(c)) { key = c; taken.add(c); } }
    const label = str(f.label, '');
    if (!label) errors.push(`Question ${i + 1} needs some text.`);
    else if (label.length > t.maxLabel) errors.push(`"${label}" is too long: labels can be ${t.maxLabel} characters at most.`);
    const field = { key, type: f.type, label, required: typeof f.required === 'boolean' ? f.required : true };
    if (t.maxOptions) {
      const options = Array.isArray(f.options) ? f.options.map((o) => String(o).trim()).filter(Boolean) : [];
      const name = label || `Question ${i + 1}`;
      if (!options.length) errors.push(`"${name}" needs at least one option.`);
      if (options.length > t.maxOptions) errors.push(`"${name}" can have ${t.maxOptions} options at most.`);
      if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) errors.push(`"${name}" has duplicate options.`);
      for (const o of options) if (o.length > LIMITS.option) errors.push(`Option "${o}" is too long: ${LIMITS.option} characters at most.`);
      field.options = options;
    }
    return field;
  }).filter(Boolean);
  return { config, errors };
}

function buildFlowJson(kind, config) {
  if (kind === 'booking_live') return liveBooking.buildFlowJson(config);
  const def = KINDS[kind];
  const children = [];
  const payload = {};
  for (const f of fieldList(config, kind)) {
    const t = FIELD_TYPES[f.type] || FIELD_TYPES.text;
    const component = { type: t.component, name: f.key, label: f.label, required: f.required };
    if (t.inputType) component['input-type'] = t.inputType;
    if (t.maxOptions) component['data-source'] = (f.options || []).map((title, i) => ({ id: `opt_${i + 1}`, title }));
    children.push(component);
    payload[f.key] = `\${form.${f.key}}`;
  }
  children.push({ type: 'Footer', label: config.submitLabel, 'on-click-action': { name: 'complete', payload } });
  return {
    version: FLOW_JSON_VERSION,
    screens: [{ id: def.screen, title: config.title, terminal: true, success: true, layout: { type: 'SingleColumnLayout', children } }],
  };
}

// A form's questions in order, as [{key, type, label, required, options?}].
// Reads both shapes: the list the editor saves, and the older per-key object
// (forms created before the builder; jsonb reorders keys, so the template's
// order is used for those).
function fieldList(config, kind) {
  const fields = config?.fields;
  if (Array.isArray(fields)) return fields;
  const defs = KINDS[kind]?.defaults.fields || {};
  const obj = fields && typeof fields === 'object' ? fields : defs;
  const keys = [...new Set([...Object.keys(defs), ...Object.keys(obj)])];
  return keys.map((key) => ({ ...defs[key], ...obj[key], key, type: obj[key]?.type || defs[key]?.type || 'text' }));
}

// Turns a parsed nfm_reply response_json into readable label/value pairs.
// Choice answers arrive as option ids (opt_N); a multiple-choice answer may
// be a list of them (Meta doesn't document that shape). Both are mapped back
// to the option text.
function describeResponse(flow, response) {
  const fields = fieldList(flow?.config, flow?.kind);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const keys = [...new Set([...fields.map((f) => f.key), ...Object.keys(response || {})])];
  const rows = [];
  for (const key of keys) {
    if (!(key in (response || {}))) continue;
    const value = response[key];
    if (key === 'flow_token' || value === '' || value == null) continue;
    const f = byKey.get(key);
    const optionText = (v) => {
      const m = /^opt_(\d+)$/.exec(String(v));
      return m && f?.options?.[Number(m[1]) - 1] ? f.options[Number(m[1]) - 1] : String(v);
    };
    const shown = Array.isArray(value)
      ? value.map((v) => (f?.options ? optionText(v) : String(v))).join(', ')
      : (f?.options ? optionText(value) : String(value));
    rows.push({ key, label: f?.label || key, value: shown });
  }
  return rows;
}

module.exports = { FLOW_JSON_VERSION, KINDS, LIMITS, FIELD_TYPES, MAX_FIELDS, fieldList, normalizeConfig, buildFlowJson, describeResponse, makeFlowToken, flowIdFromToken, chatIdFromToken };
