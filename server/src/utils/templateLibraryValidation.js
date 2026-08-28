// Validates one template_library content entry (server/src/db/
// templateLibraryContent.js) against the SAME real rules Meta submission
// itself enforces — reusing templateParams.js's actual validateTemplateText/
// validateHeaderText (the reverse-engineered words-ratio and start/end-
// variable rules included) rather than re-implementing or eyeballing them.
// This is what "every template manually checked against Meta's real
// rejection reasons" (wasi-master-plan.md §2.3) means in practice: run the
// real function, don't just read the copy and hope. Used by both
// seedTemplateLibrary.js (aborts the whole seed run on any failure) and
// server/test/templateLibraryContent.test.js (asserts zero failures).
const { validateTemplateText, validateHeaderText } = require('./templateParams');

const VALID_CATEGORIES = ['Marketing', 'Utility', 'Authentication'];
const VALID_HEADER_TYPES = ['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'];
const VALID_BUTTON_TYPES = ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'];

// Returns an array of human-readable error strings — empty means valid.
// Mirrors messageTemplateCreateSchema's own rules (validate.js) for the
// fields that schema itself checks (button counts, text-length limits),
// plus the templateParams.js checks that schema deliberately leaves to the
// route layer (sample-value coverage — see routes/templates.js's comment).
function validateLibraryEntry(entry, index) {
  const errors = [];
  const label = `[${index}] ${entry.industry || '?'} / ${entry.use_case || '?'}`;

  if (!entry.industry) errors.push(`${label}: missing industry`);
  if (!entry.use_case) errors.push(`${label}: missing use_case`);
  if (!entry.title) errors.push(`${label}: missing title`);
  if (!VALID_CATEGORIES.includes(entry.category)) {
    errors.push(`${label}: category "${entry.category}" is not one of ${VALID_CATEGORIES.join(', ')}`);
  }

  if (entry.category === 'Authentication') {
    // Authentication templates have no author-written body/header/footer/
    // buttons on Meta's side (messageTemplateCreateSchema's superRefine
    // rejects them entirely for this category) — this entry's `body` is a
    // preview-only string for the library's own browse UI, not something
    // that gets submitted. Still require it non-empty (a library card with
    // no preview text is a broken UI, not a valid content gap) and require
    // header/footer/buttons to be absent, since "Use this Template" won't
    // prefill them for this category and stale content here would be
    // actively misleading to read.
    if (!entry.body) errors.push(`${label}: Authentication entry needs a preview-only body string`);
    if (entry.header) errors.push(`${label}: Authentication entry must not set header (not submitted for this category)`);
    if (entry.footer) errors.push(`${label}: Authentication entry must not set footer (not submitted for this category)`);
    if (entry.buttons) errors.push(`${label}: Authentication entry must not set buttons (not submitted for this category)`);
    if (entry.auth_options) {
      const { codeExpirationMinutes, addSecurityDisclaimer } = entry.auth_options;
      if (codeExpirationMinutes !== undefined) {
        if (!Number.isInteger(codeExpirationMinutes) || codeExpirationMinutes < 1 || codeExpirationMinutes > 90) {
          errors.push(`${label}: auth_options.codeExpirationMinutes must be an integer between 1 and 90 (messageTemplateCreateSchema's own limit), got ${codeExpirationMinutes}`);
        }
      }
      if (addSecurityDisclaimer !== undefined && typeof addSecurityDisclaimer !== 'boolean') {
        errors.push(`${label}: auth_options.addSecurityDisclaimer must be a boolean`);
      }
    }
    return errors;
  }

  if (entry.auth_options) {
    errors.push(`${label}: auth_options is only meaningful for Authentication entries (messageTemplateCreateSchema rejects it for any other category)`);
  }

  // --- Body: the real Meta-rejection-reason check ---
  if (!entry.body) {
    errors.push(`${label}: missing body`);
  } else {
    const bodyResult = validateTemplateText(entry.body, { label: 'Body' });
    if (!bodyResult.valid) {
      errors.push(...bodyResult.errors.map((e) => `${label}: ${e}`));
    } else {
      // Sample-value coverage — Meta requires an example per named param
      // (routes/templates.js's own pre-submit check, mirrored here since
      // this is exactly the same requirement library content must meet).
      const sampleValues = entry.sample_values || {};
      for (const param of bodyResult.params) {
        if (!(param in sampleValues) || !sampleValues[param]) {
          errors.push(`${label}: body param {{${param}}} has no sample value`);
        }
      }
      // And the reverse: no orphaned sample values for a param that isn't
      // actually in the body (stale/copy-paste leftover, not a Meta
      // rejection reason, but genuinely wrong content either way).
      for (const key of Object.keys(sampleValues)) {
        if (!bodyResult.params.includes(key)) {
          errors.push(`${label}: sample value "${key}" doesn't match any {{${key}}} in the body`);
        }
      }
    }
  }

  // --- Header ---
  if (entry.header) {
    if (!VALID_HEADER_TYPES.includes(entry.header.type)) {
      errors.push(`${label}: header.type "${entry.header.type}" is not valid`);
    }
    if (entry.header.type === 'TEXT') {
      if (!entry.header.text) {
        errors.push(`${label}: header.type is TEXT but header.text is missing`);
      } else {
        if (entry.header.text.length > 60) {
          errors.push(`${label}: header text is ${entry.header.text.length} chars, Meta's limit is 60`);
        }
        const headerResult = validateHeaderText(entry.header.text);
        if (!headerResult.valid) {
          errors.push(...headerResult.errors.map((e) => `${label}: ${e}`));
        }
      }
    }
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(entry.header.type)) {
      errors.push(`${label}: media header type "${entry.header.type}" is out of scope for this content batch (no upload mechanism)`);
    }
  }

  // --- Footer ---
  if (entry.footer) {
    if (entry.footer.length > 60) {
      errors.push(`${label}: footer is ${entry.footer.length} chars, Meta's limit is 60`);
    }
    if (entry.footer.includes('{{')) {
      errors.push(`${label}: footer contains "{{" — Meta does not support variables in the footer`);
    }
  }

  // --- Buttons ---
  if (entry.buttons) {
    if (entry.buttons.length > 10) {
      errors.push(`${label}: ${entry.buttons.length} buttons, Meta's limit is 10 total`);
    }
    const urlCount = entry.buttons.filter((b) => b.type === 'URL').length;
    const phoneCount = entry.buttons.filter((b) => b.type === 'PHONE_NUMBER').length;
    if (urlCount > 2) errors.push(`${label}: ${urlCount} URL buttons, Meta's limit is 2`);
    if (phoneCount > 1) errors.push(`${label}: ${phoneCount} PHONE_NUMBER buttons, Meta's limit is 1`);
    entry.buttons.forEach((b, i) => {
      if (!VALID_BUTTON_TYPES.includes(b.type)) errors.push(`${label}: button[${i}].type "${b.type}" is not valid`);
      if (!b.text) errors.push(`${label}: button[${i}] missing text`);
      else if (b.text.length > 25) errors.push(`${label}: button[${i}].text is ${b.text.length} chars, Meta's limit is 25`);
      if (b.type === 'URL' && !/^https?:\/\//.test(b.url || '')) {
        errors.push(`${label}: button[${i}] is type URL but url "${b.url}" is not a valid http(s) URL`);
      }
      if (b.type === 'PHONE_NUMBER' && !b.phone_number) {
        errors.push(`${label}: button[${i}] is type PHONE_NUMBER but phone_number is missing`);
      }
    });
  }

  return errors;
}

// Validates a full content array, plus cross-entry checks (duplicate
// use_case within the same industry would make the library's own filter
// UI ambiguous, even though the DB has no uniqueness constraint on it).
function validateLibraryContent(entries) {
  const errors = [];
  const seen = new Set();
  entries.forEach((entry, index) => {
    errors.push(...validateLibraryEntry(entry, index));
    const key = `${entry.industry}::${entry.use_case}`;
    if (seen.has(key)) errors.push(`[${index}] duplicate (industry, use_case): ${key}`);
    seen.add(key);
  });
  return errors;
}

module.exports = { validateLibraryEntry, validateLibraryContent };
