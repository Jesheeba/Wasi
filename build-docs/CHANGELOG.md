# Changelog

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
