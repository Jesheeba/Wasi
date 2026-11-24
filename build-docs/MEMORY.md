# Project memory

## 2026-11-23 - pricing correction, migration numbers
- Meta charges service (non-template) messages from 2026-10-01, at utility
  rates, with 1,000 free per business number per month. In-window Forms are
  not unconditionally free any more. This also affects the AI-agent spec's
  per-reply Meta fee assumption (SPEC decision 27): its owner should
  re-check it.
- 2026-11-24 merge into master: production had applied up to
  104_clients_google_sub, so Forms phase 3 / ad accounts / Send form were
  renumbered to 105 / 106 / 107 (node-pg-migrate refuses out-of-order).
- Green tick: OBA has no fee documented by Meta. Meta Verified is paid and
  bought only in the WhatsApp Business app; Wasi can only show the steps.
## 2026-11-24 - client event-template follow-ups (owner: "fix them all")
- Three fixes in one commit (they share app.js/index.css/docs/one test file):
  Hub API media templates, limit visibility, preview crop.
- Hub API media: both multipart and `headerMediaUrl`; carousel via API
  still out of scope.
- Limit "used" estimate changed to Meta's rule (exclude open-window replies
  and failed sends); still Wasi-only sends.
- API key audit: the key in local server/.env matches no api_keys row at all
  (not a revoked key). That client's working key is a separate, active one.

## 2026-11-23 - WooCommerce first
- Owner: "Add woocommerce for now - build". The Ecommerce page is
  WooCommerce order messages. Shopify, abandoned carts and catalog product
  messages are shown as Coming soon on that page.
- Decisions: order messages use approved Utility templates only; one store
  per client; contacts who sent STOP are skipped; store URLs must be public
  https.

## 2026-11-23 - Flows testing, Instagram on hold
- Owner: test WhatsApp Flows on the demo account, demo names, and send test
  messages only to 9092766740. No other recipient.
- Owner: Instagram stays "Coming soon". Instagram App Review is submitted;
  build only after approval. Do not rebase the instagram branch until then.

## 2026-11-23 - placeholder pages approved
Owner approved building the 5 hidden placeholder pages in this order:
CTWA Ads, Integrations, Ecommerce, WhatsApp Flows, Instagram (PLAN.md).
- Ecommerce = catalog/product messages only; abandoned-cart recovery
  (needs a Shopify app) stays "Coming soon".
- WhatsApp Flows = fixed authored set (lead, booking, survey) with
  editable labels, not a visual designer.
- Every page shows in the nav with a "Coming soon" badge until it ships;
  no fake data on any of them.
- CTWA shows leads per ad only: no clicks/spend/CPL (no Marketing API).
- Repo is public (GitHub API answers unauthenticated), so per the
  2026-10-12 owner rule commits stay local, not pushed.

## 2026-11-21 - open issues found during the settings redesign
- Admin roles (support/billing/super_admin) are stored but never checked by
  any route: every admin has full access. Surfaced in the UI, not fixed
  (permissions change, out of a layout pass). Needs an owner decision.
- errorDialogUI.test.js test 2 is stale (predates the template type
  picker, 88bc697); fails on the pre-redesign tree too.
- WhatsApp Message Link builder is not browser-tested (needs a connected
  WABA locally).

## 2026-11-21 - settings/forms/admin redesign approved
Owner approved the plan ("build end to end"). Layout + visuals only, zero
server diffs. Drawers are `.modal-overlay.as-drawer` (same markup and ids)
rather than a second dialog system, so the global focus trap/Escape code is
reused. Wallet shows top-ups only: nothing in the app records wallet
spending, so no "spent" figure is shown (would be invented). Found while
building: Add Attribute had always failed (capitalised type vs lowercase
enum) - fixed client-side.

## 2026-11-16 - client-suspension-paywall scope
Decision: the "pay to continue" hard block gates on `clients.status ===
'suspended'` only, NOT `pending_setup`. Reason: `pending_setup` is a
separate, already-known bug - 5 real, currently-working clients (Brainlit,
RD interblocks, Know Mind, both Sirah accounts) are wrongly stuck there
despite sending fine, because nothing in this app sets
`payment_confirmed`/`active` for a client not onboarded through a Razorpay
subscription. Gating the paywall on `pending_setup` too would have shown
those 5 a false payment wall. Flagged to the user before implementing;
proceeded with `suspended`-only per the recommended option, no objection
raised. If `pending_setup` is ever fixed (see
`project_pending_setup_status_bug` in the global memory file), this scope
decision should be revisited.

## 2026-11-14 - GV Mart root cause (context for the above)
GV Mart's actual send failures that day were Meta's own error 131042
("Business eligibility payment issue") - a Meta-side WABA billing flag,
unrelated to this app. Separately, GV Mart's `clients.status` was found
stuck at `pending_setup` despite a connected WABA (the bug above). The user
manually flipped it to `active` in admin; investigated whether that itself
had any code-level effect on sending (it doesn't - `clients.status` gated
nothing before this feature) and whether the timing was coincidental with
Meta's own block clearing - not conclusively resolved, not re-investigated
further since the account was confirmed working.
