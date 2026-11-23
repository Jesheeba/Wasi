# Manual tests waiting on the owner

These need the real WhatsApp/Meta, a real store, or the live server, so
automated tests (which fake them) can't close them. Status changes to
PASSED only when the owner confirms. Test sends: **demo account only, to
9092766740 only.**

## Step 0 - put the code on the live server (needed for everything below)

1. Merge `design/v1-stage1-tokens` into `master` (it also contains the UI
   redesign, so review it first) and push.
2. On the server: `git pull`, then `./deploy.sh`. The script runs the
   pending database migrations (094, 095, 096, plus any added later) before
   restarting, and stops without restarting if one fails.
3. Open https://wasi.sirahagents.com/app, log in as the demo account, and
   check the left menu shows Forms, Ad Leads, Ecommerce and Integrations
   without a "Soon" badge, and Instagram with one.

Status: PENDING

## 1. Forms (WhatsApp Flows)

1. Forms > New form > Lead form. Name it "Wasi Demo Lead". Change one
   choice. Check the preview updates. Click Create draft.
   - Expect a row with status Draft and no "WhatsApp reported" line under it.
2. From the phone 9092766740, send any message to the demo number. This
   opens the 24-hour window.
3. Chat > open that chat > More actions (...) > Send form > pick the draft >
   Send.
   - Expect the phone to receive a message with an "Open form" button and a
     small "draft" banner.
4. On the phone, fill in the form and submit.
   - Expect a "Form submitted: Wasi Demo Lead" message with the answers in
     the chat, and Forms > the Responses count to be 1 (click it to see the
     answers).
5. Forms > Publish. Expect Published, or a clear Meta error if the demo
   business is not verified.

Report back: did the form open on the phone, and did the answers come back?

Status: PENDING

## 2. Ecommerce (WooCommerce)

Needs a WooCommerce test store on https (a free trial or test site is fine).

1. In the demo account, create and get Meta approval for a Utility template,
   e.g. `order_update`: "Hi {{first_name}}, your order {{order_no}} is now
   {{order_status}}."
2. Ecommerce > enter the store address > Connect store > approve in
   WordPress.
   - Expect to come back to Wasi with the store shown as Connected.
   - In WordPress, WooCommerce > Settings > Advanced > Webhooks should
     list two "Wasi ..." webhooks.
3. Ecommerce > "Status: completed" > Set up > choose `order_update` > map
   the variables > Save.
4. In the store, place a test order with billing phone 9092766740, then
   mark it Completed.
   - Expect the WhatsApp message on the phone, and the event to show as
     Sent under Recent order events.
5. Disconnect. Expect the two webhooks gone from WordPress.

Status: PENDING

## 3. Ad Leads (Click-to-WhatsApp)

Needs one real chat started from a Click-to-WhatsApp ad on the demo number
(even a ₹100 test ad).

1. Tap the ad from a phone and send a message.
2. Ad Leads: expect the ad listed with 1 lead; click it and open the chat.

Status: PENDING

## 4. Integrations

1. Open Integrations. Check each card matches reality: webhook configured or
   not, Zapier, API keys, payment links, WooCommerce.
2. Click each button and check it lands on the right settings page.

Status: PENDING

## 5. Read ticks and typing
Deploy first (migration 097).
1. From 9092766740, send "hi" to +91 73395 61631.
2. In Wasi (demo account), open that chat.
   - Expect: on the phone, your "hi" turns to blue ticks.
3. Start typing a reply in Wasi (don't send yet).
   - Expect: the phone shows "typing..." under the business name for up to
     25 seconds.

Status: PENDING

## 6. Block a contact
1. Within 24 hours of a message from 9092766740: open that chat, then More
   actions (...) > Block contact > Block.
   - Expect: "Contact blocked". Messages from the phone no longer arrive.
2. More actions > Unblock contact > Unblock.
   - Expect: messages arrive again.

Status: PENDING

## 7. QR codes
1. Settings > WhatsApp > Message Link > QR codes: type "Hi, I saw your
   poster" > Create QR code.
   - Expect: a QR image and a wa.me/message/... link.
2. Scan the QR with your phone's camera.
   - Expect: WhatsApp opens a chat with the demo number, with the message
     already typed.
3. Edit the message, then scan again: the new text appears. Delete it: the
   code stops working.

Status: PENDING

## 8. Conversation starters (ice breakers, commands, welcome)
1. Settings > WhatsApp > Settings > Conversation starters: add two ice
   breakers and a command "/hours - Our opening hours". Tick "Tell Wasi when
   someone opens a new chat". Click Save starters.
2. On a phone that has never chatted with the demo number (or after
   deleting the chat), open a chat with +91 73395 61631.
   - Expect: the ice breakers appear as buttons.
   - Expect: Wasi shows "Opened the chat" for that contact (it may not
     appear: Meta says this webhook can be unreliable).
3. Type "/" in the chat. Expect "/hours" to be suggested.

Status: PENDING

## 9. Green tick application
1. Settings > WhatsApp > Settings > Green tick.
   - Expect: a status (e.g. "not started").
2. Only if you really want to apply for the demo business: fill in the
   website, 5-10 links, then Apply.
   - Expect: "Application sent to Meta" and the status changes to pending.
     Meta replies by email in a few days.

Status: PENDING

## 10. WhatsApp cost and template performance
Deploy first (migration 098).
1. Analytics > WhatsApp cost.
   - Expect: totals for the last 30 days that match WhatsApp Manager >
     Insights for the demo account, give or take a day of delay.
2. Analytics > Template performance: tick "I understand this cannot be
   turned off" > Turn on.
   - This is permanent for the demo account's WhatsApp account.
   - Expect: a table of templates. Sent, delivered and read appear for
     templates used in the last 30 days.
3. Tell me whether the Cost column shows numbers. Its field name is
   unconfirmed, so if it is always 0.00 while Meta shows costs, I need to
   fix the mapping.

Status: PENDING

## 11. Report ad leads and sales to Meta
Deploy first (migration 099). Needs a chat that started from a real
Click-to-WhatsApp ad on the demo number (same as test 3).
1. Ad Leads > open the ad > on the chat, click "Mark as lead" > Report lead.
   - Expect: "Lead reported to Meta", or a red message from Meta.
   - **Send me Meta's message if it fails**: it tells us whether Meta needs
     extra access (the Marketing API tier) before this works.
2. Click "Mark sale" > enter 100 > Report sale.
   - Expect: "Sale reported to Meta".
3. In Meta Events Manager for the demo business, a WhatsApp dataset should
   show the Lead and Purchase events within about an hour.

Status: PENDING

## 12. Product messages
Deploy first (migration 100). Needs a catalog in Meta Commerce Manager
connected to the demo WhatsApp account (WhatsApp Manager > Catalog), with at
least 2 products and their SKUs (content IDs).
1. Ecommerce > Product messages > Find my catalog.
   - If it fails, copy the catalog ID from Commerce Manager, paste it and
     Save.
2. From 9092766740, send "hi" to the demo number.
3. Open the chat > More actions > Send products > One product > enter a
   SKU > Send.
   - Expect: the phone shows the product card with photo and price.
4. Repeat with "A list of products" and 2 SKUs, then "My whole catalog".
5. On the phone, add a product to the cart and send the cart.
   - Expect: the chat in Wasi shows "Cart sent" with the item and total.

Status: PENDING
