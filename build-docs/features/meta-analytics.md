# Meta analytics: real WhatsApp cost + template performance

## Purpose
Show clients what WhatsApp (Meta) actually charged them, and how each
template performs, from Meta's own data instead of estimates.

## Architecture
- **WhatsApp cost tab:** `GET /api/analytics/meta-cost?days=7|30|90`.
  - Calls Meta `pricing_analytics` (DAILY, dimensions
    PRICING_CATEGORY + PRICING_TYPE).
  - Totals, a per-category table (with how many messages were free) and a
    per-day table.
  - Money is summed in integer micro-units so totals round correctly.
  - Meta removed `conversation_analytics` on 2026-11-01; Wasi never used it.
- **Template performance tab:** `GET /api/analytics/template-insights`.
  - Meta `template_analytics` with sent, delivered, read, clicked and cost.
  - Requests are batched 10 template ids per call (Meta's limit), daily,
    over the last 30 days.
  - Cost counts only `type: amount_spent`. This label is **not confirmed**
    against a live response; check it in the manual test.
- **Turning template analytics on:** `POST /api/analytics/template-insights/enable`.
  - Requires `{confirm: true}`, a tick box in the UI.
  - Sends `is_enabled_for_insights: true` to the WABA and records
    `wabas.template_insights_enabled_at` (migration 098).
  - Meta says this cannot be turned off.
- All routes are Admin/Manager (the Analytics router gate).

## Edge cases
- No WABA connected: 409.
- Meta errors: 502 with Meta's text.
- A bad `days` value falls back to 30.
- COST is not available for WABAs billed through a Solution Partner. Wasi's
  clients pay Meta directly, so this shouldn't apply.

## Acceptance
- Totals and categories match Meta's data points.
- Nothing is switched on without confirmation.
- 12 templates are fetched in 2 batches.
- Tests: `metaAnalytics.test.js` (4), `metaAnalyticsUI.test.js` (1).
