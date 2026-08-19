// Resolves a template's {{named}} parameters to real per-contact values.
// Shared between broadcastRunner.js (the priority fix — a broadcast's
// param_mappings, set once at creation) and flowEngine.js (a send_template
// node's config.paramMappings) — same mapping shape, same resolution rules,
// so both places stay consistent rather than drifting into two slightly
// different implementations.
const metaClient = require('./metaClient');
const { extractPlaceholders } = require('./templateParams');

// Pure — no DB, no network (server/test/broadcastParamMapping.test.js).
// `mappings` is { [paramName]: {source, field, value} }, already validated
// complete against the template wherever mappings are authored (broadcast
// creation, flow node save) — this doesn't re-validate coverage, it just
// resolves whatever's there. An unresolvable entry (unknown source, or a
// contact_field naming a field the contact doesn't have) falls back to ''
// rather than throwing, so one bad mapping degrades a single recipient's
// message instead of failing the whole batch.
function resolveParamValues(mappings, contact) {
  const resolved = {};
  for (const [name, mapping] of Object.entries(mappings || {})) {
    if (mapping.source === 'contact_field') {
      resolved[name] = contact[mapping.field] || '';
    } else if (mapping.source === 'static') {
      resolved[name] = mapping.value || '';
    }
  }
  return resolved;
}

// Splits resolved param values into body vs header components — a
// template's body and header params are both named parameters in the same
// {{name}} syntax, but Meta sends them as separate component types
// (metaClient.buildNamedBodyComponents / buildNamedHeaderComponents).
function buildTemplateComponents(template, paramValues) {
  const bodyNames = new Set(extractPlaceholders(template.body).map((m) => m.name));
  const headerNames = template.header_type === 'TEXT' && template.header_content
    ? new Set(extractPlaceholders(template.header_content).map((m) => m.name))
    : new Set();

  const bodyValues = {};
  const headerValues = {};
  for (const [name, value] of Object.entries(paramValues)) {
    if (bodyNames.has(name)) bodyValues[name] = value;
    if (headerNames.has(name)) headerValues[name] = value;
  }

  return [
    ...metaClient.buildNamedHeaderComponents(headerValues),
    ...metaClient.buildNamedBodyComponents(bodyValues),
  ];
}

module.exports = { resolveParamValues, buildTemplateComponents };
