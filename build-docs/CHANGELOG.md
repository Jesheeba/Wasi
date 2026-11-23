# Changelog

## feat(integrations-page): live status of existing integrations
Integrations (no longer Soon): Webhooks, Zapier, API & AI assistants and
Razorpay payment links as cards with their real state (configured, last
delivery incl. failures, active Zaps/keys, links created), each linking to
where it is set up. Shopify card is "Coming soon" with no action. New
read-only `GET /api/integrations/status` (Admin/Manager), selects no
secret, hash or URL. Fixed while testing: `.alert`'s display overrode the
`hidden` attribute, so the connect-WhatsApp notice showed for everyone.

## feat(wallet-removal): remove wallet top-ups from the client app
Message costs can't be metered per client, so a prepaid balance had nothing
to pay for. Removed Settings > Wallet (nav item, page, quick recharge, the
Recharge modal and their handlers and CSS) and the server's
`POST /api/wallet/recharge` (plus its schema and `walletRepo.createPending`).
`GET /api/wallet` and the Razorpay webhook's wallet branch stay, so any
already-pending top-up still settles. This also removes one of the two
in-app Razorpay payment flows the Play Store payments policy could object to;
Subscription checkout remains. Test: `server/test/walletTopUpRemoved.test.js`.

## feat(ctwa-ads-page): Click-to-WhatsApp Ads page
"Ad Leads" in the nav (no longer Soon). Summary tiles (leads, ads, ad
messages), a per-ad table (leads = distinct chats, messages, first/latest
lead, "View ad" only for http(s) links), 7/30/90/all-time range, drill into
an ad's chats and open any chat. Server: `/api/analytics/ctwa` gains
totals + leadCount/firstAt/lastAt/sourceUrl/sourceType (additive) and a
400 for an invalid `since` (was a 500); new `/api/analytics/ctwa/chats`.
Both stay Admin/Manager only. No clicks/spend/CPL: no Marketing API access.

## feat(automation-rules): view, edit and enable/disable rules
The Rules table was read-only: no way to open a rule, read its full reply,
edit it or turn it off. Rows now open the Create Rule drawer in edit mode,
with a WhatsApp bubble preview of the reply and an Open flow link for flow
rules. Each row and the drawer have an Enabled/Disabled switch. PATCH
`/api/automation-rules/:id` now also takes action, flow_id (switching kind
clears the other, so the XOR constraint holds; a foreign flow_id is 400)
and status (Enabled|Disabled). Fixed: the status badge compared to 'active',
so every real 'Enabled' rule showed grey. Delete not built (no route).

## feat(coming-soon-pages): planned pages listed in the nav as "Coming soon"
Instagram, WhatsApp Flows ("Forms"), Click-to-WhatsApp Ads ("Ad Leads"),
Ecommerce and Integrations are back in the sidebar with a "Soon" badge and
an honest Coming soon page each. Removed every fake figure the hidden
placeholders carried (1,420 ad clicks, ₹14.20 CPL, sample products, fake
flow submissions and cart rules) and the "Catalog synced" toast that did
nothing. Management pages are hidden from Agents. First step of the
placeholder-pages plan (PLAN.md 2026-11-23).

## feat(settings-redesign): admin summary tiles, invite drawer, client strip
Step 6 (last). Clients: five summary tiles (all / active / pending setup /
suspended / unpaid) that filter the table; "Unpaid" filters on
payment_status, which the status dropdown can't. Onboarding: one tile per
"stuck at" stage that filters the queue. Team: initials avatars and a
warning that admin roles aren't enforced (no route checks them). Invite
Admin is a drawer with role cards that say so. Client Detail: summary strip
(status, plan, WhatsApp, templates, last login) above the tabs.

## feat(settings-redesign): remaining pop-ups as drawers
Step 5. Add Contact, New Support Ticket, Create Payment Link and Create
Automation Rule open as right-hand drawers with helper text and a "good to
know" note; Create Rule keeps its trigger/action form unchanged. Create
Payment Link's Gateway dropdown (offering "WhatsApp Pay") was removed: its
value was never sent and every link is created through Razorpay; the amount
is whole rupees to match the rounding the handler already did.
**Bug fixed:** the inner-tab handler toggled every `.inner-tab-panel` on the
page, so picking a tab in Developer blanked WhatsApp's active panel and vice
versa; now scoped to the clicked tab's own section.

## feat(settings-redesign): Team, WhatsApp, Webhook
Step 4. Team: member/active/pending tiles, member rows with initials, a
roles side note; Invite is a drawer with role cards whose descriptions match
the real route gating (Admin and Manager have identical access today - no
route is Admin-only - so the copy says so). WhatsApp, not connected: one
"how connecting works" guide + "before you start" checklist instead of three
tabs that all said "connect first". Message Link: pre-filled message
builder, Copy and Test. Webhook: read-only summary (URL, event chips, Edit)
once configured; Cancel restores the saved values; after a save that
reveals a new one-time secret the form stays open so it can be copied.

## feat(settings-redesign): Wallet, Subscription, Billing
Step 3. Wallet: summary tiles (added this month, pending top-ups, last
recharge) and the recent top-up list from the ledger GET /api/wallet always
returned but never showed; Quick recharge with preset amounts submits
through the existing recharge form (same API + Razorpay). No "spent" figure:
nothing records wallet spending. Subscription: current-plan summary + every
plan side by side; Choose opens the existing checkout modal pre-selected
(coupons unchanged). Billing: total paid / invoices / last payment tiles;
dates formatted like the tiles. Zero server diffs.

## feat(settings-redesign): shared components + Tags, Canned Responses, Attributes
Step 1+2 of [settings-forms-admin-redesign](features/settings-forms-admin-redesign.md).
Shared (design-system.css): drawer mode for any existing .modal-overlay
(`.as-drawer`, same ids/focus trap/Escape), stat tiles, list rows, inline
add row, colour swatches, option (radio) cards, chip buttons, plan cards,
WhatsApp bubble preview, side notes. Drawers ask before discarding typed
input. Tags: added inline with a colour picker, rows show contact counts
(existing /api/analytics/tags). Canned Responses: bubble-style rows, drawer
with live WhatsApp preview + character count. Attributes: rows with type
icons, drawer with type cards. **Bug fixed:** Add Attribute sent
"Text"/"Number"/"Date" but the server only accepts lowercase, so every save
from Settings returned 400; the never-saved Key/Description fields were
removed. `withSubmitLoading` now restores button icons. Zero server diffs.

## design(v1-flow-editor): use the shared design tokens, not a private copy
The visual flow editor runs in an iframe, so it never inherited the CRM's
tokens; it hard-coded its own `--wf-*` palette plus ~13 loose colours in CSS
and JSX. It now links `/breakpoints.css` at runtime (`vite-ignore`, not
bundled) and every `--wf-*` colour is `var(--shared-token, fallback)`; branch
colours moved into `--wf-edge-*` variables. Kept editor-specific on purpose:
the canvas tint `#F6F9F6` (`--bg-app` is now white per V1 decision 2, and
white node cards need contrast), text-on-accent white, and two branch colours
with no shared token. No visual change today; a token change now reaches the
editor without editing it. Local `dist/` rebuilt.

## feat(play-store): signed release build, real privacy policy, deletion page
Closed the repo-side blockers for the Play Store submission. Upload key generated
outside the repo (Play App Signing makes it resettable, so the old "unrecoverable"
warning was wrong and is corrected); first signed .aab built and jarsigner-verified
locally. marketing/privacy.html replaced (was placeholder) with a policy matching the
real processors (Meta, Supabase, Render, Resend, Razorpay), the Android app's single
permission, DPDP rights and retention. New marketing/delete-account.html for Play's
account-deletion URL requirement. Listing graphics in mobile/store-listing/. Still
manual: screenshots, Play Console steps, legal review.

## fix(templates): verify button/shop-link URLs before submission
Reported directly: discovering a dead/malformed button URL only after the
full Meta submission round trip (create, wait, 502) was too slow to
iterate on. New `GET /api/templates/verify-url` - format check (reused
SSRF guard, same risk class as the existing `resolveMediaIdFromUrl`) +
a real HEAD request (falls back to GET if HEAD is rejected), 6s timeout.
Wired to blur on the LTO shop-link field and every carousel card's button
URL: shows "✓ Link reachable" or a warning inline, in seconds. Deliberately
non-blocking (never disables Submit) - a real site can legitimately reject
a bot's check (anti-scraping, auth walls) while still working fine for a
human tapping the button in WhatsApp.

Files: `server/src/routes/templates.js`, `app.js`, `index.html`.
Tests: `server/test/verifyTemplateUrl.test.js` (6/6 pass); 37/37 on the
carousel/LTO/templateEdit/templateMediaAssets regression.

## carousel-templates
Added Meta's multi-card swipeable Carousel template (the exact format from
the user's original competitor screenshot) - zero `CAROUSEL` support
existed anywhere in this app before. Marketing-only, 2-10 cards, mutually
exclusive with header/footer/limited-time-offer. Create: multipart upload
of one image/video per card (same Resumable-Upload-handle + Media-API-id
dance as a single media header, just looped), `cards` stored per template,
one default media asset cached per `card_index` (required a new partial
unique index - the old one only allowed one default row per *template*,
not per *card*). Send: resolves one media id per card into a `carousel`
component with per-card `card_index`.

Real correction found only by reading Meta's actual docs before building
(not live trial-and-error this time): carousel's component type strings
are lowercase (`body`/`carousel`/`header`/`buttons`) at BOTH create and
send time, unlike this app's existing uppercase convention for every
other template type - a genuinely separate payload builder
(`buildCarouselPayload`), not a branch of the existing one.

Edit is intentionally impossible for a carousel row (Meta doesn't support
it at all) - the Edit button shows but stays disabled with a tooltip,
per the user's explicit choice over hiding it outright.

Files: `server/src/db/migrations/093_carousel_templates.js` (new),
`validate.js`, `metaClient.js`, `messagingService.js`,
`mediaHeaderService.js`, `templateMediaCacheRepo.js`,
`messageTemplatesRepo.js`, `routes/templates.js`, `app.js`, `index.html`,
`index.css`.
Tests: `server/test/carouselTemplates.test.js` (7/7 pass); 111/111 on the
full template/broadcast/consent impact-map regression (see TESTING.md).

## fix(cross-tab-tenant-isolation)
Reported bug: a client account's chat list sometimes showed another
client's conversations (specifically: a "Wasi Demo Client" login showing a
"TNPSC mentors" chat). Root cause: `localStorage['client_token']` is
shared across every tab on the origin. A tab left open on account A never
reloads when a SECOND tab (same shared storage) logs out and into account
B - A's own 4s poll loop then authenticates as B and renders B's chats
under A's still-stale UI chrome. Not a backend/DB isolation bug (every
query is correctly `client_id`-scoped) - purely a frontend shared-storage
race. Fixed by snapshotting the logged-in tenant id (decoded from the
JWT payload, not the raw token string) per tab and reacting to the
`storage` event, which only fires in tabs that did NOT make the write: if
the new token's tenant differs from this tab's own, force it back to the
login screen instead of silently rendering the other tenant's data. A
same-account re-login/token-refresh in another tab does NOT trigger this
(decoded tenant id matches), so normal multi-tab use of one account is
unaffected.

Files: `app.js` (`tokenTenantId`, `enterApp`, new `storage` listener).
Tests: `server/test/crossTabTenantIsolation.test.js` (2/2 pass).

## limited-time-offer-templates
Added Meta's Limited-Time-Offer template component (coupon/countdown
strip) - a competitor-confirmed gap (AiSensy/Interakt both support it,
this app had zero `LIMITED_TIME_OFFER` references anywhere). Marketing-
category only, mutually exclusive with a header (Meta's own constraint).
Create: `limitedTimeOffer: {text, hasExpiration}` on template creation,
validated and submitted as a `LIMITED_TIME_OFFER` component. Send: a
fresh `expiration_time_ms` is required on every send/broadcast when
`hasExpiration` is true (the same approved template is reused across many
sale windows, so it can't be baked in once) - chat send, Hub API send, and
broadcast creation all gained an expiry field/param for this.

UI: the create-template form gets a dedicated, Marketing-only LTO section
(checkbox + offer text + expiration toggle) that disables the header
field while active, plus a live preview strip; chat send and campaign
creation both show a conditional "offer expires in" dropdown only when
the selected template needs it.

Also stood up a local Postgres 17 test database (`docker run ...
postgres:17-alpine` on port 5433, per `.env.example`'s already-documented
recipe) and ran this project's full `createApp()`-based test suite
against it for the first time - previously blocked entirely by a missing
`TEST_DATABASE_URL` (see TESTING.md).

Files: `server/src/db/migrations/091_message_templates_limited_time_offer.js`,
`092_broadcasts_limited_time_offer_expiration.js` (new), `validate.js`,
`metaClient.js`, `messagingService.js`, `messageTemplatesRepo.js`,
`broadcastsRepo.js`, `routes/broadcasts.js`, `routes/apiV1Messages.js`,
`broadcastRunner.js`, `app.js`, `index.html`, `index.css`.
Tests: `server/test/limitedTimeOfferTemplates.test.js` (5/5 pass);
74/74 impact-map regression tests pass; 753/767 on a full-suite run (13
pre-existing, unrelated failures - see TESTING.md).

## client-suspension-paywall
Admin's "Service Off" / the payment-reminder auto-suspend runner set
`clients.status = 'suspended'`, but nothing actually enforced it - a
suspended client could log in and use the full app. Added a real
server-side gate (`requireActiveSubscription` middleware, mounted on every
client-authenticated router except billing) plus a client-side hard block
screen ("Your subscription has ended") with a reused checkout flow for the
owner to pay. `pending_setup` is deliberately untouched - separate known
bug, would otherwise falsely paywall 5 working clients.

Files: `server/src/middleware/requireActiveSubscription.js` (new),
`requireClientAuth.js`, `requireClientOrTeamAuth.js`, `app.js` (server),
`routes/authTeam.js`, `app.js` (client), `index.html`.
Tests: `server/test/clientSuspensionPaywall.test.js` (7/7 pass).
