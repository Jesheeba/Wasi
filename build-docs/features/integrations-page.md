# Integrations page

## Purpose
`view-integrations` shows 5 cards (Shopify, CRM, Webhooks, Zapier,
Razorpay) that once claimed "Connected" unconditionally and are now honest
"not connected" placeholders with no nav link. Most of what they advertise
already works elsewhere in the app, scattered across Settings:
- Webhook forwarding (`wabas.forward_to_url`, `client_webhooks`) - Settings > Webhook
- Zapier (`zapier_subscriptions`, private/beta app in `zapier-app/`)
- Hub API keys + MCP server - Settings > Developer
- n8n community node (`n8n-nodes-wasi/`, untracked in git - VERIFY state)

## Scope
One page that shows the **real connection state** of each existing
integration and links to where it is configured. No new connector.
- Webhooks: on/off from the client's webhook config, last delivery
  status/time from `webhook_deliveries`.
- Zapier: number of active subscriptions (`zapier_subscriptions`), last
  delivery.
- API / MCP: active key count, `last_used_at` of the most recent key.
- Razorpay payment links: shown as available (platform gateway, nothing to
  connect per client), links to Payments.
- **Shopify: card stays, marked "Coming soon".** A native Shopify app
  (OAuth, order/cart webhooks, app review by Shopify) is its own project;
  see ecommerce decision in PLAN.md.

## Architecture
- Server: `GET /api/integrations/status` - one tenant-scoped read per
  integration via existing repos (`apiKeysRepo`, `zapierSubscriptionsRepo`,
  webhook config + `webhook_deliveries`). Read-only, no secrets in the
  response (reuse existing masking helpers; never return `forward_secret`,
  `key_hash`, subscription secrets).
- Client: cards rendered from that response; nav item under Business.

## Impact map
- New route file mounted in `server/src/app.js` behind `requireClientAuth`
  + tenant context.
- Reads `api_keys`, `zapier_subscriptions`, `wabas`, `client_webhooks`,
  `webhook_deliveries` - confirm `wasi_app` grants on each (column-level
  SELECT on `wabas` is the known trap - migration 013).
- `index.html` `view-integrations`, nav; `app.js` render function.

## Edge cases
- No WABA connected: webhook card says "Connect WhatsApp first".
- Delivery failures: show "last delivery failed <time>" in warning style.
- Secret leakage: regression test asserts none of the known secret fields
  appear in the response.
- Agent role: hidden + 403, same as Settings > Developer.

## Acceptance criteria
1. Nav item opens the page; each card reflects real DB state for a
   disposable test client (seed a key, a subscription, a delivery).
2. Every "Configure" button lands on the right Settings section.
3. Shopify card shows "Coming soon" and no connect action.
4. Response contains no secret/hash fields (test).
5. Agent gets 403.
