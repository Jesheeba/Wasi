# WhatsApp quick wins (no new Meta permission)

Owner, 2026-11-23: "build them all". The items from
`product-discovery/capability-audit-2026-11.md` that run on the two
permissions Wasi already has. Meta shapes were checked against Meta's docs
on 2026-11-23.

## 1. Read ticks + typing indicator
- **Purpose:** the customer sees blue ticks when staff open the chat, and
  "typing..." while staff write a reply.
- **Build:**
  - `POST /api/chats/:id/read` is called when a chat is opened. It marks
    the newest inbound message read on Meta.
  - `POST /api/chats/:id/typing` is called from the reply box, at most every
    20 s while typing.
  - Both use `POST /{phone}/messages` with `status: read` and
    `message_id: <newest inbound wamid>`; typing adds
    `typing_indicator: {type: text}`.
  - Errors never reach the user: these are best effort.
- **Edge cases:**
  - No inbound message yet: nothing to mark, returns `{ sent: false }`.
  - Meta's indicator lasts up to 25 s or until the reply is sent.
  - Typing always marks read too (Meta's rule).

## 2. Block a contact
- **Purpose:** stop spam or abuse from reaching the inbox.
- **Build:**
  - Chat menu: Block / Unblock contact, via `POST|DELETE
    /api/chats/:id/block`, which calls `/{phone}/block_users`.
  - `contacts.whatsapp_blocked_at` (migration 097) records it for the UI.
  - Meta returns 200 even when a user failed (`failed_users`), so both lists
    are read, not just the status code.
- **Edge cases:**
  - Meta only allows blocking someone who messaged in the last 24 h (error
    131047). Shown as a readable message.
  - Blocking is Admin/Manager only.

## 3. QR codes and short links
- **Purpose:** printable QR / `wa.me/message/...` link with a pre-filled
  message, for posters, packaging and cards.
- **Build:**
  - Settings > WhatsApp > Message Link: create (message up to 140 chars),
    list, edit message, delete.
  - New table `whatsapp_qr_codes`: Meta returns the image URL only on
    create, so it is stored.
  - Meta calls: `/{phone}/message_qrdls`.
- **Edge cases:**
  - 2,000 per number.
  - A code deleted in WhatsApp Manager still shows here until deleted here
    (delete treats "not found" as done).

## 4. Ice breakers, commands, welcome message
- **Purpose:** first-time chatters see up to 4 tappable starter questions;
  `/commands` act as shortcuts.
- **Build:**
  - Settings > WhatsApp > Settings: read live from Meta
    (`?fields=conversational_automation`) and save with
    `POST /{phone}/conversational_automation`.
  - Validation: 4 ice breakers of up to 80 chars; 30 commands, names up to
    32 chars without a slash, descriptions up to 256; no emoji anywhere.
  - A tapped ice breaker arrives as a normal text message, so automation
    rules can answer it.
  - The `request_welcome` webhook message (sent when a customer opens a new
    chat with the welcome message on) is stored as "Opened the chat"
    instead of "[request_welcome]".
- **Edge case:** the `request_welcome` payload is not fully confirmed in
  Meta's docs; only `type` is read.

## 7. Green tick (Official Business Account) application
- **Purpose:** apply for the verified badge from Wasi and see the status.
- **Build:**
  - Settings > WhatsApp > Settings, Green tick section.
  - Status from `GET /{phone}?fields=official_business_account`.
  - Apply with `POST /{phone}/official_business_account`: website and
    country required, 5-10 supporting links, optional language, parent
    brand and notes.
- **Edge cases:**
  - Not available to numbers also on the WhatsApp Business app
    (`registration_is_on_biz_app`): explained, no form shown.
  - The status value is shown as-is, because Meta's docs disagree on the
    values.
  - After a rejection Meta enforces a 30-day wait.

## Impact map
- `metaClient.js` (new functions only).
- `routes/chats.js` (read, typing, block).
- New `routes/whatsappTools.js` (QR, conversational automation, OBA;
  Admin/Manager).
- `metaWebhook.js` (`request_welcome` body text only).
- `app.js` and `index.html`: chat open, reply box, chat menu, WhatsApp
  settings tabs.
- Migration 097.

## Acceptance criteria
1. Opening a chat sends one read call for the newest inbound message;
   typing is throttled.
2. Block calls Meta and marks the contact. A 24 h failure is reported
   clearly. Unblock reverses it.
3. A QR code can be created (image URL stored), listed, edited and deleted.
4. Ice breakers and commands save with limits enforced server-side; emoji
   is rejected.
5. Green tick: status shown; apply validates 5-10 links and https; refused
   for app-registered numbers.
6. Existing chat, webhook and settings tests still pass.
