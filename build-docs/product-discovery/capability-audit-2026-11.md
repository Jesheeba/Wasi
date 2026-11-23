# What Wasi can build: capability and permission audit

Checked 2026-11-23 against Meta's developer docs (sources per row).
Wasi's Meta app today has Advanced Access to `whatsapp_business_management`
and `whatsapp_business_messaging`. An Instagram review is pending.
**Unconfirmed** means the docs didn't state it outright; check before
committing to it.

## Read this first

- **Coexistence limits some features.** 7 of Wasi's 10 connected numbers
  also run the WhatsApp Business app (Coexistence). Calling and the Marketing
  Messages API require a number that is on Cloud API only, so most current
  clients can't use them yet.
- **Business verification.** Publishing WhatsApp Flows needs a verified
  business with good message quality. Each client needs this, not Wasi.
- **Meta removed `conversation_analytics` on 2026-11-01.** Wasi never called
  it, so nothing broke. Future cost reports should use `pricing_analytics`.

## A. Can build now: no new permission

| Feature | What it gives clients | Size | Notes |
|---|---|---|---|
| **WhatsApp Flows (forms)** | Lead, booking and survey forms inside WhatsApp; answers saved to the contact | Large | **Building now.** Static flows need no extra keys. Client's business must be verified to publish. [docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/flowsapi.md) |
| Product / catalog messages (send) | Send products from the client's own Meta catalog in chat | Medium | Sending appears to need only our messaging permission (**unconfirmed**). Without catalog read access, clients type product IDs by hand. [docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/single-product-messages/) |
| Conversions API for Business Messaging | Tell Meta which ad chats became leads/purchases, so ads optimise better | Small-medium | `whatsapp_business_manage_events` is auto-approved for apps like ours. Uses the ad data Wasi already stores. [docs](https://developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging.md) |
| Typing indicator + read receipts | Customer sees "typing..." and blue ticks when staff reply | Small | Indicator lasts up to 25 s. [docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/typing-indicators/) |
| Block users | Block spammers from the inbox | Small | Only users who messaged in the last 24 h. [docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/block-users) |
| QR codes and short links | Printable QR / wa.me link with a pre-filled message | Small | 2,000 per number, no scan analytics. [docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/qr-codes) |
| Ice breakers, commands, welcome message | Suggested first questions shown to new chatters | Small | Up to 4 ice breakers. |
| Pricing and template analytics | Real Meta cost per day and per-template performance | Small-medium | Turning on template analytics **cannot be undone**. [docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/analytics) |
| Green tick (OBA) application | Apply for the verified badge from Wasi | Small | Client's business must be verified first. One open application at a time. |
| Flows with a live data endpoint | Forms that check slots or prices live | Large | Needs an encryption key per number and a hosted endpoint. After static Flows. |

## B. Needs extra Meta access or onboarding

| Feature | What Meta requires | Effort on our side |
|---|---|---|
| **Instagram DMs** | Pending review: `instagram_business_basic`, `instagram_business_manage_messages`. Human Agent tag (7-day replies) is reviewed separately. | Branch exists; rebase and finish after approval. |
| Catalog product picker / sync | `catalog_management` via App Review | Medium. Makes product messages usable without typing IDs. |
| Click-to-WhatsApp ad clicks, spend, cost per lead | `ads_read` Full access via App Review; Marketing API access tier (needs 500-1,500 API calls in 15 days, docs conflict); possibly `business_management` | Medium. The Ad Leads page would gain the numbers it deliberately leaves out. |
| WhatsApp Payments India (UPI in chat) | Each client accepts WhatsApp Payments terms and creates a payment configuration with a gateway (Razorpay works without allowlisting; PayU/Cashfree need it) | Medium-large: `order_details` messages, payment webhooks, reconciliation. |
| Marketing Messages API (better delivery for offers) | Re-onboard each client with the `marketing_messages_lite` feature; client accepts terms; **Cloud-API-only numbers** | Medium. Excludes most current (Coexistence) clients. |
| WhatsApp Calling | No new permission, but number must be Cloud-API-only; business-initiated calls need a 2,000/day tier | Large (voice media handling). Excludes Coexistence numbers. |
| Facebook Messenger | `pages_messaging` + `pages_manage_metadata` via App Review (`business_management` dependency) | Large: a new channel and inbox. |

## C. Needs another company's approval (not Meta)

| Feature | Requires | See |
|---|---|---|
| Shopify app (orders, shipping, COD, abandoned cart) | Shopify Partner account; "Level 2 protected customer data" approval; App Store review for public listing | [ecommerce-integration-guide.md](ecommerce-integration-guide.md) |
| WooCommerce | Nothing: client approves access in one click. **Built 2026-11-23** (order messages) | same guide |

## D. Blocked by our own gaps, not by Meta

- **Production backups and dev/prod separation.** Required for Shopify
  Level 2 data; also a standing risk on its own.
- **`smb_message_echoes` not subscribed.** Replies sent from a client's own
  phone are invisible to Wasi; this blocks the AI agent's safe auto-send.
- **Legal text.** Terms page is a placeholder; AI processing and WhatsApp
  consent wording need a lawyer.
- **Repository is public.** Pushes and deploys are paused until it's
  private, so no new feature reaches production meanwhile.

## Suggested order

1. WhatsApp Flows (in progress).
2. Quick wins with no permission: typing indicator + read receipts, QR codes,
   ice breakers, block user, Conversions API for ad leads.
3. Product messages (send with typed IDs) + apply for `catalog_management`.
4. WooCommerce connector; Shopify custom-distribution app for first clients.
5. Apply for `ads_read` to complete the Ad Leads page.
6. After approvals: Instagram, then Shopify public app.

## Not confirmed

- That sending product messages needs nothing beyond our messaging
  permission, and that a WABA can have only one catalog.
- Whether Payments works on Coexistence numbers, and its verification rules.
- Whether a Tech Provider can use the Marketing Messages API onboarding
  shortcut (docs name Solution Partners).
- Calling permission-request limits (docs conflict).
