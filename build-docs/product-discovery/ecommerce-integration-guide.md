# Connecting Shopify and other stores to Wasi

Researched 2026-11-23 from Shopify, WooCommerce and Meta docs (links inline).
Items marked **unconfirmed** need checking before you rely on them.

## What clients get

- Order confirmation, shipping/tracking update, COD confirmation (with
  Confirm/Cancel buttons) and abandoned-cart recovery on WhatsApp.
- Store customers synced into Wasi Contacts.

All of these are WhatsApp **templates** sent through Wasi's existing send
path. The store integration only supplies the events and the data.

## Two things to know first

1. **The "paste a token" shortcut is gone.** Since 1 January 2026 stores can
   no longer create admin custom apps. New apps are built in Shopify's Dev
   Dashboard ([changelog](https://shopify.dev/changelog/legacy-custom-apps-can-t-be-created-after-january-1-2026.md)).
2. **Shopify classes customer phone, name and address as "Level 2 protected
   data".** To read them Wasi must meet Shopify's security requirements:
   encrypted backups, separate test and production data, access logs and an
   incident policy ([protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data)).
   **Wasi does not meet these today**: production has no backups and shares
   its database with development. Fix both before applying.

## Recommended path

### Phase 0: works now, no Shopify review

**Option A: Shopify Flow or Zapier → Wasi API.** The client builds a Flow
or Zap: "order created" → `POST /api/v1/messages` with a template and the
order fields. This uses Wasi's existing Hub API and Zapier app, so it needs
no new code. Limits: no abandoned carts, no customer sync, setup per client.

**Option B: a "custom distribution" Shopify app.** This is the same code as
the public app, so nothing is wasted. You get an install link per store and
no App Store review. Limits: one app per store (or per Shopify Plus org),
and you can't bill through Shopify. Use this for the first 2-5 clients.

**WooCommerce** needs no marketplace review at all. See the table below.

### Phase 1: public Shopify App Store app

1. Create a **Shopify Partner** account and a development store for testing.
2. Build with the **GraphQL Admin API only**. New public apps can't use REST
   ([requirement](https://shopify.dev/changelog/starting-april-2025-new-public-apps-submitted-to-shopify-app-store-must-use-graphql)).
   Pin an API version and upgrade it every few months.
3. Request the minimum scopes:
   - `read_orders`: orders and abandoned checkouts. Covers the last 60 days
     only; older history needs `read_all_orders` (**unconfirmed**).
   - `read_customers`.
   - `read_fulfillments`: tracking updates.
   - `write_orders`: only if COD replies should tag the order.
4. Apply for **Level 2 protected customer data**, one field at a time
   (phone, name, email, address), in the Dev Dashboard. This is the
   backups / data-separation step from above.
5. **Install flow:** OAuth on install, then open Wasi's settings page inside
   Shopify admin (App Bridge, session tokens, no third-party cookies). The
   client links the store to their Wasi account there.
6. **Mandatory privacy webhooks**: `customers/data_request`,
   `customers/redact` and `shop/redact`. Return 2xx, act within 30 days.
   The app is rejected without them.
7. **Order and customer webhooks**:
   - Orders: `orders/create`, `orders/cancelled`, `orders/fulfilled`.
   - Shipping: `fulfillments/create`, `fulfillments/update`.
   - Checkouts: `checkouts/create`, `checkouts/update`.
   - Customers: `customers/create`, `customers/update`,
     `customers_marketing_consent/update`.
   - Lifecycle: `app/uninstalled`.

   Verify each webhook's `X-Shopify-Hmac-Sha256` against the raw body and
   skip duplicates by webhook ID.
8. **Billing**: App Store apps must charge through Shopify's billing.
   Decide the Shopify-side price, or keep the app free only if Shopify
   accepts that.
9. **Submit for review**: listing, privacy policy (now live), test login,
   screencast. Expect 30+ days.

### Abandoned cart: how it actually works

Shopify sends no "abandoned" webhook. The pattern is:

1. A `checkouts/create` or `checkouts/update` event arrives with a phone
   number.
2. Wasi schedules a check 30-60 minutes later.
3. If the checkout is still not completed, Wasi sends a recovery template
   with the checkout link.

This uses the same job-table pattern Wasi already uses for broadcasts.

### Consent (needs a lawyer's eye)

- Meta requires an opt-in that names the business, and recommends separate
  opt-ins for order updates and offers
  ([opt-in rules](https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in/)).
- Shopify has SMS and email marketing consent but no WhatsApp field. Safest
  is a checkout checkbox that says "WhatsApp" and names the store.
- Order and shipping messages are lower risk than offers. Confirm under
  India's DPDP Act.
- A Shopify sync must never overwrite a WhatsApp STOP. Wasi's sticky
  opt-out already enforces this.

## Other platforms

| Platform | How to connect | Review needed |
|---|---|---|
| WooCommerce | One-click key grant (`/wc-auth/v1/authorize`) returns REST keys to Wasi. Wasi then registers order and customer webhooks, signed with `X-WC-Webhook-Signature`. Abandoned carts need a plugin. ([docs](https://woocommerce.github.io/woocommerce-rest-api-docs/#authentication)) | No |
| Magento / Adobe Commerce | Integration token plus REST, or the Commerce Webhooks module ([docs](https://developer.adobe.com/commerce/extensibility/webhooks/signature-verification)) | No (Marketplace optional) |
| BigCommerce | OAuth app plus webhooks; has a cart-abandoned event (**unconfirmed**) | App marketplace review if listed |
| Wix | Wix app (OAuth) plus webhooks (**unconfirmed**) | Wix app review if listed |
| Shiprocket | Shipment-status webhooks for tracking and NDR updates (**unconfirmed**) | No |
| Dukaan | API/webhook availability **unconfirmed**; Zapier or a webhook URL | - |

## Suggested order for Wasi

1. **Now:** document Phase 0 Option A (Zapier / Shopify Flow → Hub API) for
   clients, and fix backups and dev/prod separation.
2. **Next:** WooCommerce connector (no review) and the Shopify app with
   custom distribution for the first clients. Same code as step 3.
3. **Then:** submit the public Shopify app once Level 2 requirements are met.
4. **On demand:** Shiprocket tracking, Magento, BigCommerce.

## Still open

- Shopify review timeline (forum reports only).
- The exact `checkouts/update` payload fields.
- The `read_all_orders` request process.
- Whether Level 2 approval also triggers a separate data-protection review.
- Pricing through Shopify Billing.
- Checkout consent wording (legal).
