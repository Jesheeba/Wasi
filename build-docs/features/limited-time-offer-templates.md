# Limited-Time-Offer templates

## Purpose
Part of the CRM-wide messaging audit (2026-11-16). Meta's Limited-Time-Offer
(LTO) template is a Marketing template subtype that renders a coupon-style
strip ("Sale ends in...", an expiry countdown, a copyable offer code) — a
pattern AiSensy and Interakt both support for flash-sale/discount
broadcasts. Confirmed by grep: zero `LIMITED_TIME_OFFER` references
anywhere in `metaClient.js`/`validate.js`. Structurally this is the
smallest of the four messaging gaps found in this audit — it is a
template **component addition**, not a new send type or new Meta
object (unlike Flows/catalog messages above).

## Architecture
**Create (`metaClient.js` / `validate.js`)**
- `messageTemplateCreateSchema` grows an optional `limitedTimeOffer:
  {text: string (max 16 chars, e.g. "Use code 25OFF"), hasExpiration:
  boolean}` field, mutually exclusive with `header.type !== 'NONE'`
  per Meta's real constraint (an LTO template cannot also carry a media/
  text header — confirmed in Meta's own template docs referenced by this
  audit's web research last turn).
- `buildUtilityMarketingPayload` (line 611) grows one more component
  branch: `{type: 'LIMITED_TIME_OFFER', limited_time_offer: {text,
  has_expiration}}`, appended alongside the existing BODY/FOOTER/BUTTONS
  components it already assembles — the least invasive of the three new
  features, a pure addition to an existing function with an established
  per-component-type branch pattern.
- Category must be Marketing (Meta restriction) — enforced in the same
  `superRefine` block that already branches on `category === 'Authentication'`.

**Send (`messagingService.js` / `metaClient.js`)**
- At send time, Meta requires the component's
  `limited_time_offer.expiration_time_ms` parameter when
  `has_expiration` was true at creation — a new required field in
  `sendTemplateMessage`'s caller-supplied `components`, computed from a
  client-chosen offer duration (e.g. "expires in 24h from send") rather
  than hardcoded at template-creation time, since the same approved
  template is reused across many sends/broadcasts with different expiry
  moments.
- `broadcastRunner.js`/chat send UI need a small new prompt ("offer
  expires in: ___") when the selected template has an LTO component —
  same shape as today's existing "supply body param examples at send
  time" prompt for a named-parameter template, not a new UI pattern.

## Impact map
- `server/src/utils/validate.js` — `messageTemplateCreateSchema`
  (`limitedTimeOffer` field + mutual-exclusion-with-header refine).
- `server/src/utils/metaClient.js` — `buildUtilityMarketingPayload`
  (new component branch), `sendTemplateMessage` caller contract
  (`expiration_time_ms` passthrough — no signature change, it already
  accepts an opaque `components` array).
- `server/src/services/messagingService.js` — send-time expiry
  parameter assembly, alongside the existing Authentication-code
  component-assembly branch (line 141-159) as the closest precedent for
  "a template category needs one extra computed send-time parameter."
- `app.js`/`index.html` — template create modal (one new optional field
  under Marketing category only), send-time expiry prompt.
- **Does not touch**: carousel templates, Flows, catalog messages (all
  independent features in this same audit), Authentication/Utility
  template paths.

## Edge cases and failure modes
- `limitedTimeOffer.text` over Meta's 16-character cap → rejected locally
  (400), mirroring every other template-field length cap already enforced
  in this schema (header 60 chars, footer 60 chars, button text 25 chars).
- LTO + non-NONE header on the same template → rejected locally before
  the Meta call (Meta's own real constraint, not an arbitrary one this
  app is inventing).
- `has_expiration: true` at creation but no expiry supplied at send time →
  reject the send pre-flight with a clear message, not a Meta 400 the
  client can't interpret.
- Category other than Marketing with `limitedTimeOffer` present → rejected
  locally, same enforcement point as the existing Authentication-can't-
  have-body/header/footer/buttons rule.

## Acceptance criteria
1. Creating a Marketing template with an LTO component (no header) submits
   successfully to Meta and stores the component shape locally.
2. Creating an LTO template with a header, or with `limitedTimeOffer.text`
   over 16 chars, or on a non-Marketing category, is rejected locally
   (400), verified with no Meta call made in the test.
3. Sending an approved LTO template with `has_expiration: true` requires
   and correctly forwards `expiration_time_ms` in the real Meta send
   payload.
4. Existing (non-LTO) Marketing/Utility/Authentication template create and
   send paths are provably unaffected (existing template test suite passes
   unmodified).
