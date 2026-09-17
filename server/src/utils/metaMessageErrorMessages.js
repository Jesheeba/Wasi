// PLAN.md item 28 (broadcast per-recipient detail view): a plain-language
// mapping for Meta's numeric message-delivery error codes. Distinct from
// routes/templates.js's describeMetaError, which only handles TEMPLATE
// SUBMISSION rejections (error_user_title/error_user_msg on a create/edit/
// delete call) — a different Meta error shape, not reusable here. No
// mapping for message-send/delivery failures existed anywhere in this
// codebase before this.
//
// Codes confirmed against Meta's official Cloud API error code reference
// (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes),
// not guessed. Deliberately not exhaustive — Meta documents dozens of
// codes, most of them (OAuth/permission/business-verification) can't occur
// on a per-recipient broadcast send at all. Extend this list in place when
// a real, recurring code turns up that isn't here yet — same discipline
// CLAUDE.md's template-category-mismatch entry already established for
// content-pattern lists: never build a second, parallel mapping.
const MESSAGE_ERROR_MESSAGES = {
  4: 'Meta rate-limited this send — it was retried automatically.',
  130429: 'Meta rate-limited this send — it was retried automatically.',
  131026: "This number can't receive WhatsApp messages (not on WhatsApp, or has an outdated app).",
  131047: "More than 24 hours passed since this contact last messaged you — a session message can't be sent outside that window.",
  131048: "Blocked due to your account's current quality rating.",
  131049: "Not delivered — Meta's own spam-prevention system held this back to protect delivery for everyone.",
  131050: 'This contact has opted out of marketing messages.',
  131051: 'Unsupported message type for this recipient.',
  131052: "Meta couldn't download media this recipient sent.",
  131053: 'Meta could not upload the media in this message.',
  131056: 'Too many messages sent to this recipient in a short period.',
  131057: 'Your WhatsApp Business account is temporarily in maintenance mode.',
  132000: "The template's parameter count didn't match what was sent.",
  132001: "This template doesn't exist in this language, or isn't approved yet.",
  132005: "A template parameter exceeded Meta's length limit.",
  132007: "This template's content was found to violate WhatsApp policy.",
  132012: 'A template parameter was formatted incorrectly (e.g. a date or currency value).',
  132015: 'This template is paused due to low quality.',
  132016: 'This template was permanently disabled after repeated quality issues.',
  133010: "This phone number isn't registered on the WhatsApp Business Platform.",
};

// metaErrorCode: the numeric code from messages.meta_error_code (a real
// delivery failure reported via the status webhook). errorReason: the raw
// text already stored — messages.error_reason (Meta's error.title) for a
// post-send failure, or broadcast_recipients.error_reason (a JS err.message,
// no Meta code at all) for a pre-send failure/skip. A known code always
// wins over the raw text (plain language beats Meta's own often-terse
// title); an unknown code falls back to whatever raw text is stored rather
// than hiding it.
function describeMessageFailure({ metaErrorCode, errorReason } = {}) {
  if (metaErrorCode && MESSAGE_ERROR_MESSAGES[metaErrorCode]) {
    return MESSAGE_ERROR_MESSAGES[metaErrorCode];
  }
  if (errorReason) return errorReason;
  return 'Message could not be delivered.';
}

module.exports = { describeMessageFailure, MESSAGE_ERROR_MESSAGES };
