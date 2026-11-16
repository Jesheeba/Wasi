# Carousel templates

## Purpose
The user shared a WhatsApp message screenshot (a competitor's broadcast):
one shared intro body, followed by 2+ horizontally swipeable cards, each
with its own image, short text, and a "Read more"/CTA link. That's Meta's
**Carousel template** type (`components: [{type:"CAROUSEL", cards:[...]}]`).
Confirmed by reading the code: this app cannot build or send one today.
`metaClient.js` (the only place that builds the Graph API template payload)
has zero references to `CAROUSEL` anywhere, and `messageTemplateCreateSchema`
(validate.js) has no `cards` field. The `coach_workshop_promo_sample`
template submitted earlier this session is a correct but ordinary
single-card Marketing template — not what the screenshot showed.

## Live verification (2026-11-16)
Unlike limited-time-offer-templates (which needed 3 rounds of real-Meta
fixes), the user manually created and submitted a real carousel template
through the deployed app and confirmed it worked - no undocumented Meta
requirement surfaced this time. No code changes needed.

## Scope decision (confirming before implementing)
Corrected against Meta's own "Media card carousel templates" doc
(fetched 2026-11-16, Graph API v27.0) - two corrections to the original
draft of this section below:
- **Marketing category only** - Meta does not support carousel cards on
  Utility templates at all (the original draft said "Marketing or
  Utility," which was wrong).
- **Component type strings are lowercase** at create time for this
  specific feature (`"type": "body"`, `"type": "carousel"`, nested cards'
  `"header"`/"body"`/`"buttons"`) - unlike this app's existing
  `buildUtilityMarketingPayload`, which uses uppercase (`HEADER`/`BODY`/
  `FOOTER`/`BUTTONS`) for every other template type and has worked that
  way in production for years. Carousel gets its own lowercase branch,
  not a case change to the existing one. (Confirmed separately, live,
  for Limited-Time-Offer: Meta's create-time casing is inconsistent
  across newer template features - LTO's own `LIMITED_TIME_OFFER`
  component type is uppercase at create time but lowercase
  `limited_time_offer` at send time. Carousel's doc shows lowercase at
  BOTH create and send time - followed as documented, verified against
  the live API same as LTO was, fixing anything the docs got wrong.)
- 2–10 cards per carousel. Per card: header is `image` or `video` only
  (no document, no text, no none). Body text is optional per card, but
  "if any card includes a card body text, then all cards must include
  one" - and if present, capped at 160 chars (separate from the
  top-level body's 1024). Buttons: up to 2 per card, any mix of
  `quick_reply`/`url`/`phone_number` - but "all cards defined on a
  template must have the same components," so every card needs the
  same button count/types/order as every other card.
- The top-level template still has its own plain `BODY` component (same
  as today, max 1024). Meta's own examples never show a top-level
  HEADER or FOOTER alongside carousel - not explicitly forbidden in the
  text, but absent from every example, so this app treats both as
  disallowed-with-carousel (matching the LTO precedent's own header/
  footer exclusions) until a real submission says otherwise.
- Once approved, a carousel template **cannot be edited** via Meta's API
  at all (not just header, the whole thing) — only delete + recreate.

**Resolved (2026-11-16)**: show the Edit button for a carousel row but
disable it, with a tooltip/explanation that Meta doesn't support editing
a carousel template (delete + recreate only) - consistent with every
other template type always showing Edit, rather than a carousel row
being visually different for no apparent reason.

## Architecture

**Data model**
- `message_templates` gets one new nullable column: `cards jsonb` — an
  array of `{ headerType: 'IMAGE'|'VIDEO', headerText?, bodyText,
  buttons: [...] }`, mirroring the existing flat body/header/buttons shape
  but per-card. `header_type` on the template row itself stays as today
  (NONE/TEXT/IMAGE/VIDEO/DOCUMENT) for the top-level header, which a
  carousel template does NOT use (Meta: top-level header must be absent when
  CAROUSEL is present) — so `cards` being non-null implies `header_type =
  'NONE'` at the top level, enforced in the schema's `superRefine`, not by
  convention.
- `template_media_cache` (migration 028) already supports multiple assets
  per `template_id` with one `is_default` flag — reused as-is, just keyed
  per card via a new `card_index int` column (nullable; null = the
  template's own top-level media, same as today). No new table needed.

**Create flow (`server/src/routes/templates.js` POST `/`)**
- `messageTemplateCreateSchema` grows a `cards` array (2–10 items), each
  validated like today's single header/body/buttons but narrower (no
  TEXT/NONE/DOCUMENT header, no footer, no PHONE_NUMBER button, 1024-char
  body cap per Meta's card body limit which is actually 160 chars per
  card — must special-case this, not reuse the 1024 top-level limit).
- Media upload: today's single `uploadHeaderMedia.single('headerFile')`
  becomes `.array('cardFiles')` when `cards` is present — one file per card,
  same resumable-upload-handle + Media-API-id dance as today
  (`metaClient.createUploadSession`/`uploadFileBytes`/`uploadMedia`), just
  looped per card instead of once. Each card's resulting media id is cached
  via `templateMediaCacheRepo.insertAsset(..., cardIndex)`.
- `metaClient.buildUtilityMarketingPayload` grows a branch: when `data.cards`
  is present, append a `{type: 'CAROUSEL', cards: [...]}` component built
  from each card's header/body/buttons, instead of (not in addition to) a
  top-level HEADER component.

**Send flow (`server/src/services/messagingService.js` /
`mediaHeaderService.js`)**
- `sendChatMessage`'s existing single-header media resolution
  (`mediaHeaderService.resolveMediaId`/`resolveMediaIdFromUrl`, line
  161-175) only resolves one media id. A carousel send needs one resolved
  media id **per card**, assembled into a `CAROUSEL` components entry
  mirroring the create-time shape. This is the single largest new piece of
  logic — not a small tweak, a new `resolveCarouselMediaIds`-style function
  alongside the existing one, reusing the same per-asset cache lookup in a
  loop.
- `broadcastRunner.js` and `flowEngine.js` (anything that currently calls
  `sendChatMessage`/`metaClient.sendTemplateMessage` with a template) need
  no change themselves — they already pass `templateComponents` through
  opaquely; the carousel-specific building happens once inside
  `messagingService.js`.

**Sync flow (`templateSyncService.js` / `messageTemplatesRepo.createFromMetaSync`)**
- A carousel template created directly in Meta Business Manager (not
  through this app) syncs in via the existing manual "Sync" button. Its
  `components` will include a `CAROUSEL` entry with no cached media at all
  (same gap this app already has for a single media header synced in from
  Meta — `templateMediaAssets.test.js`'s whole premise). Must store the
  parsed `cards` shape (text/buttons only, no media id) so the template at
  least displays correctly and is editable-as-duplicate, even though it
  can't be *sent* until someone uploads real media for each card via the
  same "add header media asset" flow this app already has for single
  headers (`POST /:id/header-media`), extended to accept a `cardIndex`.

**Frontend (`app.js` / `index.html`)**
- Template create modal: a new "Carousel" header-type option that, when
  picked, swaps the single header/body/button section for a repeatable
  per-card editor (image upload + body + buttons, add/remove card, 2-10
  bound), reusing the existing per-field validation UI patterns already in
  the modal rather than inventing new ones.
- Template list/detail view: render cards as a horizontally scrollable
  preview row, matching the actual WhatsApp rendering (closest existing
  analog: the template preview panel already renders header/body/footer/
  buttons for a normal template — extend it, don't replace it).
- Broadcast composer / chat template picker: when a carousel template is
  selected, prompt for one media file per card (or reuse cached default
  assets per card) before send — same UX pattern as today's single
  media-header prompt, just looped.

## Impact map
- `server/src/db/migrations/0NN_carousel_templates.js` (new) — `cards`
  column on `message_templates`, `card_index` column on
  `template_media_cache`.
- `server/src/utils/validate.js` — `messageTemplateCreateSchema` (add
  `cards`, branch `superRefine`), `messageTemplateUpdateSchema` stays
  unchanged (carousel is never edited, only duplicated).
- `server/src/utils/metaClient.js` — `buildUtilityMarketingPayload` (new
  CAROUSEL branch), `buildTemplateCreatePayload` dispatch unaffected.
- `server/src/routes/templates.js` — POST `/` (multi-file upload branch),
  GET `/:id/header-media` / POST `/:id/header-media/:assetId/default`
  (accept `cardIndex`).
- `server/src/services/mediaHeaderService.js` — new carousel-aware
  resolution helper; existing single-header helpers untouched (still used
  by every non-carousel template, the overwhelming majority).
- `server/src/services/messagingService.js` — `sendChatMessage`'s
  media-header branch (line 161-175) grows a carousel case alongside the
  existing single-header case, not a replacement.
- `server/src/repositories/messageTemplatesRepo.js`,
  `templateMediaCacheRepo.js` — new columns, no breaking changes to
  existing reads (both nullable, default absent).
- `server/src/services/templateSyncService.js` — parse `CAROUSEL` out of a
  synced-in template's `components`, same best-effort treatment single
  media headers already get.
- `app.js` / `index.html` — create modal, template preview, broadcast
  composer, chat template picker. This is the largest single chunk of new
  frontend code in the feature.
- **Does not touch**: Authentication templates, `broadcastRunner.js`/
  `flowEngine.js` call sites (they already forward `templateComponents`
  opaquely), consent gating (`assertConsentForTemplate` keys off
  `template.category`, unaffected by `cards` existing or not).

## Edge cases and failure modes
- Fewer than 2 or more than 10 cards → reject at schema validation, same
  400 shape as today's other template validation errors.
- Cards with mismatched button count/type across cards → reject locally
  before ever calling Meta (same philosophy as today's URL/phone button
  count checks in `superRefine`) — Meta's own rejection message for this is
  unhelpfully generic, so catching it here first is a real UX improvement,
  not just mirroring Meta.
- Card body over Meta's actual 160-character carousel-card limit (separate
  from the top-level 1024 limit) → new, specific validation message.
- One card's media upload to Meta succeeds, a later card's fails midway
  through the loop → the whole create request must fail and roll back
  (don't call `createMessageTemplate` with partially-uploaded cards); no
  local DB row should be created for a template Meta never actually
  received a complete card set for. Mirrors today's single-header
  all-or-nothing behavior, just extended to "all cards or nothing."
- Sending a carousel template where one card's cached media asset was since
  deleted/never uploaded → `MediaResolutionError`, surfaced as today's
  existing `media_resolution_failed` code, not a silent partial send (Meta
  doesn't support sending a carousel with a missing card anyway).
- A carousel template synced in from Meta Business Manager with no cached
  media at all for any card → stored and viewable, but send attempts fail
  clearly (`media_resolution_failed`) until someone uploads real assets per
  card — same gap/fix pattern `templateMediaAssets.test.js` already covers
  for single headers, just per-card.
- Template category Authentication + `cards` present → rejected at schema
  level (Authentication already forbids header/body/buttons entirely; this
  extends the same superRefine branch).

## Acceptance criteria
1. Creating a 2-10 card carousel Marketing/Utility template with per-card
   image + body + matching buttons succeeds end-to-end: real Meta
   `message_templates` POST, real `meta_template_id` returned, local row
   stores `cards` + per-card cached media asset ids.
2. Creating a carousel with mismatched button types/counts across cards, or
   with <2 or >10 cards, or with a card body over 160 chars, is rejected
   locally (400) before any Meta call — verified by asserting no
   `graph.facebook.com` fetch happened in the test (same convention as
   existing template tests stubbing `global.fetch`).
3. A connected-WABA client can send an approved carousel template from a
   chat/broadcast and the resulting Meta API call's `components` includes a
   correctly-shaped `CAROUSEL` entry with every card's real resolved media
   id, matching Meta's documented send-time shape.
4. Attempting to send a carousel template with a card missing a cached media
   asset fails with `media_resolution_failed`, not a partial/malformed send
   to Meta.
5. An existing non-carousel template's create/edit/send/sync paths are
   provably unaffected (existing template test suite — `templateEdit`,
   `templateMediaAssets`, `templateSync`, `templateLibrary*`,
   `consentTracking` — still passes unmodified).
6. A carousel template created directly in Meta Business Manager syncs into
   this app via the existing Sync button and displays correctly (cards,
   text, buttons) even with no cached media, without crashing the sync or
   the template list UI.
