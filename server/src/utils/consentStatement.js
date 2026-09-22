// Consent hardening Phase 2 — the exact wording shown in the bulk/per-
// contact opt-in confirmation modal (app.js) and stored verbatim in each
// resulting consent_events.evidence (routes/contacts.js). One named
// constant, not duplicated inline in either place, so the wording can
// change without touching either the UI or the route that records it — the
// approved-by-direct-instruction requirement this file exists to satisfy.
//
// DRAFT TEXT — pending the client's own legal review before relying on it
// (same placeholder-legal-text caveat CLAUDE.md already records for this
// app's privacy/terms pages). Edit this one line, not any call site.
const CONSENT_STATEMENT =
  'I confirm that these contacts have given my business permission to receive marketing messages from us on WhatsApp, and that I can provide evidence of that permission if asked.';

// Dual CommonJS/browser export — same zero-dependency, served-as-a-static-
// asset pattern templateParams.js already established (server/src/app.js's
// GET /templateParams.js), so the UI and the server read the literal same
// string rather than a hand-copied duplicate that could drift.
const consentStatement = { CONSENT_STATEMENT };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = consentStatement;
} else if (typeof window !== 'undefined') {
  window.consentStatement = consentStatement;
}
