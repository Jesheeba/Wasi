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

## Proposed (awaiting approval)

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
