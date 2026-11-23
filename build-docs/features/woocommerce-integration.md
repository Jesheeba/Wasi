# WooCommerce integration (Ecommerce page)

## Purpose
Owner, 2026-11-23: "Add woocommerce for now - build". WooCommerce needs no
marketplace review (unlike Shopify, see
`product-discovery/ecommerce-integration-guide.md`). A store owner connects
their store once. From then on, order events send the client's own WhatsApp
templates automatically: order placed, processing, completed, cancelled,
and so on.

## Scope
- Connect, two ways:
  - **One-click:** WooCommerce's `/wc-auth/v1/authorize`. The store POSTs
    REST keys to Wasi's callback.
  - **Manual:** the client pastes a consumer key and secret created under
    WooCommerce > Settings > Advanced > REST API (needs Read/Write).
- On connect, Wasi creates two webhooks on the store (`order.created`,
  `order.updated`), each signed with a per-store secret.
- Message rules, one per trigger:
  - Triggers: `order_created`, plus `status_<s>` for each WooCommerce core
    status (pending, processing, on-hold, completed, cancelled, refunded,
    failed).
  - Each rule picks an approved **Utility** template and maps every
    template variable to an order field. Order updates are transactional,
    and marketing templates need opt-in.
- Each order event:
  - Normalises the billing phone and upserts the contact and chat.
  - Skips contacts who sent STOP.
  - Sends the template through `messagingService.sendChatMessage` and logs
    the result.
- The page shows the store's status, the rules, and the 50 most recent
  events with the reason for each skip or failure.
- **Out of scope:** abandoned carts (WooCommerce has no checkout event; it
  needs a store plugin), product catalog sync, and more than one store per
  client.

## Architecture
- Migration `096_ecommerce_woocommerce.js` adds three tenant tables (RLS +
  wasi_app grants):
  - `ecommerce_stores`: keys and webhook secret encrypted, connect token
    for one-click.
  - `ecommerce_message_rules`: unique `(store_id, trigger)`.
  - `ecommerce_events`: unique `(store_id, dedupe_key)`. Only the order
    fields used are stored, never the full order (data minimisation).
- `utils/publicUrl.js`: a store URL must be https and resolve only to
  public addresses. Requests to the store use `redirect: 'error'`. This is
  the SSRF guard: the server calls a URL the client typed in.
- `services/wooClient.js` handles the WooCommerce REST calls (Basic auth,
  15 s timeout).
- `utils/wooOrders.js` (pure): phone normalisation, order fields, trigger
  for a topic and status, and template components.
- `services/ecommerceService.js`: connect/finish setup, `handleWooEvent`.
- `routes/ecommerce.js`: the client API (Admin/Manager).
- `routes/wooWebhook.js`: the public auth callback and the per-store
  webhook. It returns 200 before sending, because WooCommerce times out
  webhooks after a few seconds.
- UI: `#view-ecommerce`, plus a WooCommerce card on Integrations.

## Impact map
- `messagingService.sendChatMessage`: reused unchanged (template path,
  consent gate, plan limit).
- `contactsRepo.upsertByPhone`, `chatsRepo.findOrCreateByContact`: reused.
- `server/src/app.js`: two new mounts. The webhook route needs `req.rawBody`
  (already captured globally).
- Integrations page: one more card.
- Nothing else changes.

## Edge cases
- **Phone** missing or not convertible to international format: the event
  is logged as `skipped`, with the reason.
  - 10 digits with country IN or blank becomes `91…`.
  - A leading `0` plus 10 digits drops the `0` and adds `91`.
  - A leading `+` or 11-15 digits is kept as is.
- `order.updated` fires on any edit: deduplicated per order and status, so
  each status sends at most once.
- WooCommerce's creation "ping" (form body `webhook_id=…`) gets a 200 and is
  ignored.
- A bad or missing signature returns 401 and nothing is stored.
- A redelivery with the same order and status is a no-op.
- No rule for a trigger: logged as `no_rule`. Template missing or not
  approved: `failed`, with the reason.
- WhatsApp not connected: `failed` ("Connect WhatsApp").
- Disconnect removes the webhooks from the store (best effort) and deletes
  the keys.
- A one-click callback whose token matches no pending store returns 400.
- Private, loopback or link-local store URLs, and non-https URLs, are
  rejected with 400.

## Acceptance criteria
1. Connecting with keys verifies them and creates both webhooks on the store.
2. A signed `order.created` with a rule sends the mapped template to the
   normalised phone, and creates or updates the contact.
3. The same status twice sends once. A STOP'd contact is skipped. A bad
   signature gets 401.
4. Marketing templates can't be chosen for a rule (400).
5. Private and loopback store URLs are rejected.
6. The UI connects, saves a rule with its variable mapping, and lists events.
7. Existing sending and webhook tests still pass.
