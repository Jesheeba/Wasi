# wasi-zapier-app

A private/beta [Zapier](https://zapier.com) integration for Wasi's WhatsApp Hub API (`wasi-master-plan.md` §3.1, Tier 2 — "no-code connector"). Connect it to a Zap and trigger on incoming WhatsApp messages, or send WhatsApp messages as an action — no custom code required.

This is a thin translation layer over Wasi's existing Hub API (`/api/v1/*`) — the same contract `mcp-server/` already wraps for AI clients. Nothing here is a separate product, and nothing here reimplements send/receive logic: every action and trigger calls a real, already-hardened backend endpoint.

**Scope: private/beta only.** This app is built and tested for one Wasi account's own use, distributed by direct invite link — it has not been submitted to Zapier's certified app directory (`wasi-master-plan.md` §3.3). Do not submit it for certification without a separate review pass.

## Setup

You need:
1. A Wasi Hub API key — from **Settings → Developer** inside your Wasi account (self-serve: click "+ New API Key," name it "Zapier").
2. Your Wasi instance's base URL.

In Zapier, when connecting this app, enter your **Wasi Base URL** and paste your **API Key** — the same key mechanism every other Wasi Hub API integration uses (Postman, the MCP server, custom scripts). Zapier stores it securely on your connection; only you can see or revoke it (from the same Settings → Developer page).

## Trigger

**New WhatsApp Message Received** — fires instantly when a customer sends a new WhatsApp message to your connected number. This is a REST Hook (instant) trigger, not polling: turning the Zap on registers a subscription (`POST /api/v1/subscriptions`) that rides the same durable, retried delivery queue (`webhook_deliveries` + `forwardRunner.js`) Wasi already uses for its own CRM webhook forwarding — nothing new was built for delivery, only a new subscription record. Turning the Zap off unsubscribes (`DELETE /api/v1/subscriptions/:id`).

There is no "load sample data" polling fallback yet (a known gap — see `CLAUDE.md`) — Wasi has no endpoint to list recent inbound messages on demand. Send yourself a real WhatsApp message while testing the trigger in Zapier's setup flow.

## Action

**Send WhatsApp Message** — sends a text or template message through your connected number (`POST /api/v1/messages`, the same endpoint the Hub API, MCP server, and root CRM app's own Hub-API-backed sends all use).

- **Text**: only deliverable within 24h of the customer's last inbound message (WhatsApp's session window).
- **Template**: pre-approved, works any time. Template Parameters accepts JSON, e.g. `{"customer_name": "Asha"}`.

Interactive button/list messages are not exposed here yet — Wasi's interactive types need dynamic field mapping that doesn't fit Zapier's static form-field UI well. Documented as a known gap, not built this pass.

## Security

- The API key lives only in Zapier's own encrypted connection storage — this app never logs it or writes it anywhere else.
- Every action/trigger is scoped to exactly the Wasi account your API key belongs to — the same isolation the rest of the Hub API already enforces.
- No OAuth "Connected Apps" dependency (`wasi-master-plan.md` §8.6, a later, separate phase): the master plan's own build order sequences that layer *after* this integration, needed only when moving from private/beta to certified public distribution — not to ship at all. This app uses the same Bearer API key every other Hub API consumer already uses, not a shared/master secret.

## Development

```bash
npm install
npm run test:integration   # real end-to-end against the actual backend + shared DB
```

`test:integration` drives this app's real `authentication.js`/`triggers/`/`creates/` through `zapier-platform-core`'s own `createAppTester`, against the real Wasi backend (`server/src/app.js`) and the shared dev/production database, using a disposable, clearly-prefixed test client deleted afterward — same pattern as `mcp-server/test/integration.test.js`. Requires `ALLOW_SHARED_PRODUCTION_DB=yes-i-understand-the-risk` for that one invocation. Only the outbound call to `graph.facebook.com` is faked; no real WhatsApp message is ever sent.

Note for anyone extending this app's tests: `zapier-platform-core` monkey-patches `global.fetch` process-wide (for its own request logging), not just for its own `z.request()` calls — since this test runs the real backend in the same process, a fake `fetch()` response needs a real `Headers` instance (`headers: new Headers()`), not a plain object, or `zapier-platform-core`'s own logging wrapper throws when it tries to read the fake response's headers.

## Deploying to Zapier

```bash
npm install -g zapier-platform-cli
zapier login
zapier push
```

Keep visibility set to private/invite-only in the Zapier Developer Platform dashboard — `zapier push` alone does not make an app public; certified/public listing is a separate, later review process this integration hasn't gone through.
