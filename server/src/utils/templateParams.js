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

// Meta enforces a words-to-parameters ratio server-side (error_subcode
// 2388293, error_user_title "Params Words Ratio Exceeds Limit") but has
// never published the exact formula — checked Meta's Template Overview,
// Guidelines, and Error Codes reference pages directly; none state a
// threshold. This rule is reverse-engineered, corroborated independently by
// two BSPs (Mercuri, Syniverse docs): total words >= 3 * parameter count + 1.
// Applied here with one extra word of safety margin (+2 total) since it's
// unofficial and Meta could tighten it without notice. Validated against a
// real rejection hit live during Phase 2 verification: "Hello
// {{customer_name}}, thanks!" (3 whitespace tokens, 1 param) was rejected by
// Meta with this exact subcode — this rule requires 5, correctly blocking it
// locally instead of round-tripping to Meta for the same rejection.
const MIN_WORDS_PER_PARAM = 3;
const MIN_WORDS_SAFETY_MARGIN = 2;

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function minWordsRequired(paramCount) {
  return MIN_WORDS_PER_PARAM * paramCount + MIN_WORDS_SAFETY_MARGIN;
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

  // Occurrence count, not deduped — a repeated {{name}} still occupies its
  // own slot and dilutes the ratio the same way a distinct parameter would.
  const paramCount = matches.length;
  const wordCount = countWords(text);
  const required = minWordsRequired(paramCount);
  if (wordCount < required) {
    errors.push(
      `${label} has too few words for its ${paramCount} parameter${paramCount === 1 ? '' : 's'} ` +
      `(${wordCount} word${wordCount === 1 ? '' : 's'}, needs at least ${required}) — Meta rejects templates that ` +
      `are mostly variables with little surrounding text (error 2388293, "Params Words Ratio Exceeds Limit"). ` +
      `Add more descriptive text around the variable(s), or reduce the number of parameters.`
    );
    return { valid: false, paramFormat: 'named', params: [], errors };
  }

  return { valid: true, paramFormat: 'named', params: uniqueInOrder(namedMatches.map((m) => m.name)), errors: [] };
}

// Meta requires an example value per named parameter for template review.
// There's no UI yet for an author to supply real examples, so this derives
// a readable placeholder from the parameter name itself (e.g.
// "customer_name" -> "Customer Name"). Used as a frontend preview
// suggestion / fallback only — the actual submitted example now comes from
// the author-supplied sample values (routes/templates.js), which Meta
// requires, not just recommends.
function defaultExampleFor(paramName) {
  const words = paramName.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length ? words.join(' ') : paramName;
}

// Header text differs from body: Meta allows at most ONE {{variable}}, not
// several. Deliberately narrower than validateTemplateText, not a
// header-specific superset of it — the start/end-variable rule and the
// words-ratio rule above were both reverse-engineered specifically against
// BODY rejections; neither has been confirmed to apply to headers, so this
// only checks numbered-vs-named and the one-param cap. This is the "small
// addition" this module's header comment anticipated.
function validateHeaderText(text) {
  const matches = extractPlaceholders(text);
  if (!matches.length) {
    return { valid: true, paramFormat: 'none', params: [], errors: [] };
  }

  const numericMatches = matches.filter((m) => isPurelyNumeric(m.name));
  const namedMatches = matches.filter((m) => !isPurelyNumeric(m.name));
  const errors = [];

  if (numericMatches.length > 0) {
    errors.push(
      `Header uses a numbered parameter (${uniqueInOrder(numericMatches.map((m) => m.raw)).join(', ')}) — ` +
      `Meta no longer accepts these. Use a named parameter instead, e.g. {{customer_name}}.`
    );
  }
  if (matches.length > 1) {
    errors.push(`Header can have at most one variable — found ${matches.length}.`);
  }
  if (errors.length > 0) {
    return { valid: false, paramFormat: numericMatches.length ? 'positional' : 'named', params: [], errors };
  }

  return { valid: true, paramFormat: 'named', params: uniqueInOrder(namedMatches.map((m) => m.name)), errors: [] };
}

module.exports = {
  extractPlaceholders,
  isPurelyNumeric,
  isVariableAtStartOrEnd,
  countWords,
  minWordsRequired,
  validateTemplateText,
  validateHeaderText,
  defaultExampleFor,
};
