# Master Plan

Pre-existing app/design work is tracked under `build-docs/design-research/`,
`design-system-discovery/`, `product-discovery/` (not retrofitted here).
This file tracks features built under the global build workflow going forward.

## Done

- [client-suspension-paywall](features/client-suspension-paywall.md) — built, tested, committed 2026-11-16.
  Triggered by: GV Mart investigation (2026-11-14/16) found `clients.status`
  does not actually gate client access anywhere today, despite admin's
  "Service Off" toggle claiming it does.
- [limited-time-offer-templates](features/limited-time-offer-templates.md) — built, tested (5/5 new, 74/74 regression, 753/767 full suite), 2026-11-16.
  Triggered by: messaging/template competitor audit (2026-11-16). Also
  stood up a local Postgres 17 test DB, closing the previously-documented
  "no TEST_DATABASE_URL" gap (see TESTING.md).
- [carousel-templates](features/carousel-templates.md) — built, tested (7/7 new, 111/111 regression), 2026-11-16.
  Triggered by: the user asking where the carousel from their original
  screenshot was, after realizing only limited-time-offer had been built.
  Scope question (edit UX) resolved: Edit button shown but disabled with
  a tooltip, not hidden.
- Template type picker (no separate feature doc - a UI fix to the
  cross-cutting decision below, not a new Meta capability) — built
  2026-11-16. Triggered by: the user flagging the LTO/Carousel checkboxes
  stacked inside one form as "too congested" once they saw it live.
  Replaces both checkboxes with a 4-card "choose type first" picker
  (Marketing/Utility, Carousel, Limited-Time-Offer, Authentication) -
  `app.js`'s `setTemplateType`/`openCreateTemplateModal`, new
  `#modal-template-type-picker` in `index.html`. The checkboxes still
  exist in the DOM (hidden) so the existing, already-tested mutual-
  exclusion/validation logic reading their state is untouched.

## Proposed (awaiting approval) - placeholder pages, 2026-11-23

Owner asked to "develop" the 5 hidden placeholder pages (Ecommerce,
WhatsApp Flows, Instagram, CTWA, Integrations). They are very different in
size and two are blocked outside engineering, so they are planned
separately, in build order:

1. [ctwa-ads-page](features/ctwa-ads-page.md) - **done 2026-11-23**. small. Server data already
   captured (`messages.referral`, `/api/analytics/ctwa`); UI only + 2
   additive fields. Shows leads per ad, never invented clicks/spend/CPL
   (no Marketing API access).
2. [integrations-page](features/integrations-page.md) - **done 2026-11-23**. small. Real status
   of integrations that already work (webhooks, Zapier, API/MCP, Razorpay
   links). Shopify card marked "Coming soon".
3. [catalog-product-messages](features/catalog-product-messages.md) -
   medium. Becomes the **Ecommerce** page: send product / product-list
   messages from the client's own Meta Commerce catalog. Abandoned-cart
   recovery needs a store integration (Shopify) and is NOT in scope; that
   section is marked "Coming soon". VERIFY: needs `catalog_management`
   permission on the Meta app.
4. [whatsapp-flows](features/whatsapp-flows.md) - **built 2026-11-23, live Meta check pending.** large. Fixed set of
   authored Flow templates (lead form, booking, survey), send + store
   `nfm_reply`. Open question in the doc still needs an answer.
5. [instagram-dm](features/instagram-dm.md) - **on hold (owner, 2026-11-23): stays "Coming soon" until Meta approves the submitted Instagram review.** Medium engineering, blocked
   on Meta App Review + rebasing a 2-month-old branch and renumbering its
   migrations. Engineering can start; going live cannot until Meta approves.

Until each one ships, its page is shown in the nav with a "Coming soon"
badge (no fake data), so the owner's original request is met on day one.

## Proposed (awaiting approval) - earlier

Scope for this batch: messaging/template gaps only (user's explicit choice,
2026-11-16, after a full-CRM audit review — AI Agent/Instagram/Dashboard/
etc. from `product-discovery/missing-feature-candidates.md` stay out of
scope for now).

**Cross-cutting UI decision (applies to all four below)**: the user
explicitly asked that creating/sending a template NOT be one dropdown
inside a single form. Each message type (plain Marketing/Utility,
Carousel, Limited-Time-Offer, Flow, Catalog/Product) gets its own entry
point — a gallery of type cards to pick from first, each opening its own
purpose-built, minimal form (only the fields that type actually needs),
rather than one giant form with conditional fields toggling in and out.
Applies symmetrically on the send side too (composer picks a message kind
first, then gets that kind's own minimal send UI).

- [whatsapp-flows](features/whatsapp-flows.md) — not started. Native
  interactive forms (lead forms, booking, surveys) inside a WhatsApp
  message — competitor-confirmed gap (AiSensy/WATI/Interakt all support
  it), zero support here. One open scope question (fixed template set vs
  full visual Flow-JSON designer) needs an answer before implementation.
- [catalog-product-messages](features/catalog-product-messages.md) — not
  started. Single/multi-product messages referencing a client's own Meta
  Commerce Catalog — competitor-confirmed gap. Deliberately scoped
  narrower than the already-flagged Shopify/e-commerce integration gap
  (no catalog browsing/sync built here, just send-time references to a
  catalog the client manages in Meta Commerce Manager directly). One open
  scope confirmation in the doc.
- [settings-forms-admin-redesign](features/settings-forms-admin-redesign.md) -
  complete 2026-11-21 (approved same day). Owner: Settings, pop-ups and
  admin feel "very basic, all forms". Audited all 35 screens locally plus
  competitor/SaaS research. Layout + visuals only, zero server changes:
  summary-first sections, inline add for 1-2 field lists, right-side drawers
  for 3+ field forms, live WhatsApp previews, admin summary tiles. 6 commits.
