// Named-parameter parsing/validation for WhatsApp message template text
// (body and, if ever added, header). Meta's WhatsApp Business Platform now
// rejects the old numbered {{1}}/{{2}} positional style for new templates —
// confirmed by live rejection in WhatsApp Manager — so every template must
// use named parameters ({{customer_name}}) instead. Kept separate from
// metaClient.js so the parsing/validation logic is unit-testable without a
// real Meta App (see server/test/templateParams.test.js).
//
// Payload shapes below were verified against Meta's current docs
// (developers.facebook.com/documentation/business-messaging/whatsapp,
// Templates > Overview and Templates > Components) before implementation:
//   - top-level `parameter_format: "named"` (lowercase) on template creation
//   - component-level `example.body_text_named_params: [{ param_name, example }]`
//   - send-time body parameter objects: `{ type: "text", parameter_name, text }`
// HEADER named params (`header_text_named_params`) are documented the same
// way as BODY, but this codebase has no header field on templates yet, so
// only BODY is wired up — the parsing/validation functions here are generic
// text-in, so header support is a small addition when a header field exists.
// BUTTON named-parameter shapes are NOT documented by Meta as of this
// writing (only positional/index syntax was confirmed for buttons) — button
// support is intentionally not implemented; treat it as unverified/by-analogy
// only if it's ever added.

const PLACEHOLDER_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;

function extractPlaceholders(text) {
  const matches = [];
  const re = new RegExp(PLACEHOLDER_RE); // fresh instance — a /g/ RegExp is stateful across exec() calls
  let m;
  while ((m = re.exec(text || ''))) {
    matches.push({ raw: m[0], name: m[1], index: m.index, end: m.index + m[0].length });
  }
  return matches;
}

function isPurelyNumeric(name) {
  return /^[0-9]+$/.test(name);
}

function uniqueInOrder(items) {
  return [...new Set(items)];
}

// A variable can't be the very first or last token of the (trimmed) text —
// Meta's most common cause of automatic template rejection.
function isVariableAtStartOrEnd(text) {
  const trimmed = (text || '').trim();
  const matches = extractPlaceholders(trimmed);
  if (!matches.length) return false;
  return matches[0].index === 0 || matches[matches.length - 1].end === trimmed.length;
}

// Validates one piece of template text. Returns
// { valid, paramFormat: 'named'|'positional'|'none', params, errors }.
function validateTemplateText(text, { label = 'Body' } = {}) {
  const matches = extractPlaceholders(text);
  if (!matches.length) {
    return { valid: true, paramFormat: 'none', params: [], errors: [] };
  }

  const numericMatches = matches.filter((m) => isPurelyNumeric(m.name));
  const namedMatches = matches.filter((m) => !isPurelyNumeric(m.name));
  const errors = [];

  if (numericMatches.length > 0) {
    errors.push(
      `${label} uses numbered parameters (${uniqueInOrder(numericMatches.map((m) => m.raw)).join(', ')}) — ` +
      `Meta no longer accepts these. Use named parameters instead, e.g. {{customer_name}}.`
    );
  }
  if (numericMatches.length > 0 && namedMatches.length > 0) {
    errors.push(`${label} mixes numbered and named parameters in one template — Meta does not support this. Use one style only.`);
  }
  if (errors.length > 0) {
    return { valid: false, paramFormat: numericMatches.length ? 'positional' : 'named', params: [], errors };
  }

  if (isVariableAtStartOrEnd(text)) {
    errors.push(`${label} cannot start or end with a variable — add surrounding text before/after {{${matches[0].name}}}.`);
    return { valid: false, paramFormat: 'named', params: [], errors };
  }

  return { valid: true, paramFormat: 'named', params: uniqueInOrder(namedMatches.map((m) => m.name)), errors: [] };
}

// Meta requires an example value per named parameter for template review.
// There's no UI yet for an author to supply real examples, so this derives
// a readable placeholder from the parameter name itself (e.g.
// "customer_name" -> "Customer Name").
function defaultExampleFor(paramName) {
  const words = paramName.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length ? words.join(' ') : paramName;
}

module.exports = {
  extractPlaceholders,
  isPurelyNumeric,
  isVariableAtStartOrEnd,
  validateTemplateText,
  defaultExampleFor,
};
