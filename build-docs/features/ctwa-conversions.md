# Ad lead feedback to Meta (Conversions API for Business Messaging)

## Purpose
When a chat that started from a Click-to-WhatsApp ad becomes a lead or a
sale, tell Meta. Meta then optimises the ad towards people like that
customer, which lowers cost per lead.

## Architecture
- Ad Leads > an ad > each chat has **Mark as lead** and **Mark sale**.
  - The sale asks for an amount in INR.
  - "Lead reported" / "Sale reported" badges replace the buttons once done.
- Route: `POST /api/analytics/ctwa/chats/:chatId/conversion` with
  `{ event: LeadSubmitted | Purchase, value?, currency? }`. Admin/Manager,
  from the Analytics router.
- `ctwa_clid` is read from the chat's first inbound message with
  `referral.ctwa_clid` (already stored by the webhook since migration 065).
- Dataset: `POST /{WABA_ID}/dataset` (idempotent) is called once and the id
  stored in `wabas.ctwa_dataset_id` (migration 099).
- Event: `POST /{dataset}/events` with:
  - `action_source: business_messaging`, `messaging_channel: whatsapp`
  - `user_data: { whatsapp_business_account_id, ctwa_clid }` (clid not
    hashed)
  - `custom_data: { currency, value }` for sales
  - `partner_agent: wasi`
- `ctwa_conversions` has a unique `(chat_id, event_name)`: Meta does not
  deduplicate, so Wasi never sends the same event twice for a chat.

## Edge cases
- No `ctwa_clid` (Status-placement ads, or old chats): 409, and the UI says
  "Can't report to Meta".
- Meta refusal: 502 with Meta's text; nothing recorded, so it can be retried.
- **Permissions risk:** `whatsapp_business_manage_events` is said to be
  auto-approved with our messaging access, but Meta also lists a Marketing
  API access tier. Live testing will show whether Meta refuses. The error
  then names the missing access.
- The dataset response field is unconfirmed (`id` or `dataset_id` are both
  accepted).

## Tests
- `ctwaConversions.test.js` (5): refused without a clid; a Meta refusal
  records nothing; the dataset is created once; event payload; repeat
  refused; a sale needs an amount and sends value + currency; list fields.
- `ctwaAdsPage` regression.
