# Catalog / product messages

## Purpose
Part of the CRM-wide messaging audit (2026-11-16). AiSensy, WATI, and
Interakt all support sending a single product or a multi-product list
pulled from a Meta/Facebook Commerce Catalog, inline in chat (the
`interactive.type: 'product'` / `'product_list'` message shapes) — common
for D2C/retail clients closing a sale directly in WhatsApp. Confirmed by
grep: zero `catalog_id`/`product_retailer_id`/`catalog_message`/
`product_list` references anywhere in `metaClient.js`, and the earlier
"Missing Feature Candidates" audit (`build-docs/product-discovery/
missing-feature-candidates.md`) already separately flags that "Shopify /
other e-commerce Tier 1 native integration... zero backing code found."
This feature is narrower than that: it does not sync a product catalog
from Shopify — it sends messages referencing products already in a
**Meta/Facebook Commerce Catalog the client manages themselves** in Meta
Commerce Manager, which this app has no relationship to at all today.

## Scope decision (confirming before implementing)
Two meaningfully different things both get called "catalog" by
competitors:
1. **Catalog-aware send** (this doc's actual scope): send a product/
   product-list message referencing a catalog the client already set up
   directly in Meta Commerce Manager. No catalog CRUD in this app at all —
   just a `catalog_id` + product retailer IDs typed/picked by the client.
2. **Full catalog management** (out of scope here, overlaps the
   already-flagged Shopify/e-commerce gap): browsing/editing the catalog's
   products from inside this CRM, syncing from Shopify, etc.
**Proposing**: build (1) only. (2) stays exactly where the existing audit
already placed it — a separate, larger, UNDECIDED product question.
**Needs your confirmation**: does this narrower scope match what you
actually want, given the competitor screenshots you're comparing against
likely show the client's own already-configured catalog?

## Architecture
**Send (`metaClient.js`)**
- New `sendCatalogMessage(phoneNumberId, accessToken, toPhone,
  {bodyText, footer, catalogId, productRetailerId})` for a single product:
  `interactive.type: 'catalog_message'`, `action.name:
  'catalog_message'`, `action.parameters: {thumbnail_product_retailer_id}`.
- New `sendProductListMessage(phoneNumberId, accessToken, toPhone,
  {bodyText, header, footer, catalogId, sections})` for a multi-product
  list: `interactive.type: 'product_list'`, `sections: [{title,
  product_items: [{product_retailer_id}]}]` — structurally the closest
  existing analog is `sendListMessage` (line 452), which already loops
  `sections`/`rows`; this is the same shape with `product_items` instead
  of free-text `rows`.
- Both require the WABA to actually have a catalog connected
  (`wabas.catalog_id` — new nullable column; Meta's own prerequisite,
  checked via `GET /{waba_id}?fields=connected_catalog`, not something
  this app can grant). Send attempt with no connected catalog fails
  pre-flight with a clear "connect a product catalog to this WhatsApp
  number in Meta Commerce Manager first" error, same philosophy as
  today's `waba_not_connected`/media-header-needs-WABA checks.

**UI (`app.js`/`index.html`)**
- Chat composer and broadcast composer both grow a "Product" send option
  alongside today's text/template/interactive options. Since there's no
  in-app catalog browser (explicitly out of scope), the picker is a plain
  "paste product retailer ID(s)" field, not a visual product grid — honest
  about what this app can actually offer without catalog sync, not a fake
  browse experience with no real data behind it.

## Impact map
- `server/src/utils/metaClient.js` — two new send functions.
- `server/src/utils/validate.js` — new fields on `apiMessageSendSchema`
  (`catalogId`, `productRetailerId`, `sections` reused-shape for product
  lists) and the internal chat-send schema.
- `server/src/services/messagingService.js` — `sendChatMessage` grows the
  dispatch for these two new interactive sub-shapes, same `type:
  'interactive'` top-level type as today (button/list already share one
  type value decided by which fields are present — this extends that same
  pattern, not a new top-level `type`).
- `server/src/repositories/wabasRepo.js` — `catalog_id`/connected-catalog
  check.
- `app.js`/`index.html` — composer additions (chat + broadcast).
- **Does not touch**: template creation/schema (catalog messages are
  free-form interactive sends, not templates — no Meta approval step,
  same as today's button/list messages), Shopify/e-commerce integration
  (explicitly deferred, see scope decision above).

## Edge cases and failure modes
- WABA has no catalog connected → pre-flight rejection, no Meta call made
  (mirrors `waba_not_connected`).
- `productRetailerId` doesn't exist in the connected catalog → Meta
  rejects at send time; surfaced via the existing `describeMetaError`-
  wrapped failure path, not a new error class (this app cannot validate a
  product id exists without a catalog browse feature it doesn't have).
- Outside the 24h session window with no approved template → same
  `session_window_closed` rule as every other free-form interactive send.
- More than 30 products across sections, or more than 10 sections (Meta's
  documented product-list caps) → rejected locally before the Meta call,
  mirroring the existing list-message 10-rows-total check (line 709-720
  in `validate.js`) as the direct precedent for this exact kind of
  cross-item cap.

## Acceptance criteria
1. A WABA with a connected Meta catalog can send a single-product message
   and a multi-product list message from chat and from a broadcast.
2. A WABA with no connected catalog gets a clear pre-flight error, no
   Meta call attempted.
3. Exceeding Meta's product/section caps is rejected locally (400),
   verified with no `graph.facebook.com` fetch in the test, matching the
   existing list-message cap test's convention.
4. Existing list/button interactive sends are provably unaffected
   (existing interactive-message tests pass unmodified).
