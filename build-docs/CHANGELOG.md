# Changelog

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
