# Changelog

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
