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

Status: PASSED (2026-11-24) - deployed by the owner; live app.js has the form builder, prod pgmigrations has 105-109 applied. The menu check (step 3) is still the owner's to eyeball.

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

## 13. Booking forms with live free slots
Deploy first (migration 101). Do test 1 (basic Forms) first: this builds
on it.
1. Forms > New form > "Booking with live slots". Name it "Wasi Demo
   Booking". Pick days, 10:00-12:00, 30 minutes, 1 person per slot. Click
   Create draft.
   - Expect: a Draft row with no "WhatsApp reported" line. If there is one,
     send me the text: it is Meta checking the form.
2. From 9092766740, send "hi" to the demo number. In Wasi, open the chat >
   More actions > Send form > pick it > Send.
3. On the phone, open the form and pick tomorrow.
   - Expect: only 10:00, 10:30, 11:00 and 11:30 appear.
4. Pick 10:00, enter a name, and book.
   - Expect: a confirmation in WhatsApp, and "Form submitted" with name,
     date and time in the Wasi chat.
5. Send the form again, pick the same day.
   - Expect: 10:00 is gone.

If step 3 shows an error inside WhatsApp, tell me what it says: it usually
means Meta could not reach or decrypt the endpoint.

Status: PENDING

## 14. Forms: contact fields, send anytime, CSV, bookings
Deploy first (migration 105).
1. Settings > Attributes: add a text field "Course". Forms > your Lead form
   > Contact fields > "Interested in" -> Course > Save.
2. Send the form to 9092766740 and submit it.
   - Expect: the contact's Course field shows your choice (Contacts > open
     the contact).
3. Forms > the form > Send anytime > Marketing > Send for approval.
   - Expect: "Template: pending" under the form; "approved" after Meta
     reviews it (minutes to a day).
4. After approval, open a chat whose last customer message is older than 24
   hours > Send form.
   - Expect: the phone receives the template with an Open form button.
5. Forms > click the Responses number > Download CSV. Expect a spreadsheet
   with one row per answer.
6. For a live booking form: Responses shows "Upcoming bookings". Cancel one.
   Expect that time to become bookable again.

Status: PENDING

## 15. Ad spend and cost per lead (your own ad account first)
Needs the owner setup in build-docs/features/ctwa-ad-metrics.md (steps 1-3)
and a deploy (migration 106).
1. Ad Leads > Connect ad account > sign in with your Facebook account (an
   admin of the Wasi Meta app) > choose your ad account.
   - Expect: back on Ad Leads with "Meta ad account connected".
2. Expect "Ad spend" and "Cost per lead" tiles, and Spend / Clicks / Cost
   per lead for ads that brought chats.
3. Compare the spend for one ad with Meta Ads Manager for the same dates.
4. A client account will see Meta's refusal until App Review approves
   ads_read: expected for now.

Status: PENDING

## 16. Onboarding form + "Send form" step in a Bot Flow
Deploy first (migration 107). Demo account, phone 9092766740 only.
1. Forms > New form > "Business onboarding". Name it "Wasi Onboarding". Check
   the preview shows business name, your name, email, industry, plan,
   current WhatsApp tool and website. Click Create draft.
   - Expect: a Draft row with no "WhatsApp reported" line. If there is one,
     send me the text.
2. Automation > Flows > New Flow "Onboarding". Add Node > Send Form > pick
   "Wasi Onboarding (draft)" > Add Node. Add a second node: Send Text
   "Thanks! Our team will call you within a day." On the Send Form node,
   Add Branch > "The form is submitted" > the Send Text node. Set the Send
   Form node as entry. Activate.
3. Automation > Rules > New Rule: keyword "join", start the "Onboarding"
   flow. Save.
4. From 9092766740, send "join" to +91 73395 61631.
   - Expect: the phone gets the "Please fill in this short form." message
     with an "Open form" button (and a small draft banner).
5. Before opening the form, send "hello".
   - Expect: nothing else arrives; the flow is still waiting for the form.
6. Open the form, fill it in, submit.
   - Expect: the chat shows "Form submitted: Wasi Onboarding" with the
     answers, then the phone gets "Thanks! Our team will call you within a
     day."
   - Forms > Responses for Wasi Onboarding shows 1.

Status: PENDING

## 17. Hub API image template + sending limit (after deploy)

1. Demo account > Settings > Developer: create a key. Run:
   `curl -X POST https://wasi.sirahagents.com/api/v1/templates -H "Authorization: Bearer <key>" -F 'data={"name":"api_image_test","category":"Utility","language":"en_US","header":{"type":"IMAGE"},"body":"This is a test of image templates from the API."}' -F "file=@poster.jpg;type=image/jpeg"`
   - Expect 201 with a `meta_template_id`; the template shows in Templates
     as pending with the image.
2. `curl https://wasi.sirahagents.com/api/v1/account -H "Authorization: Bearer <key>"`
   - Expect `messaging_limit` with the demo number's tier.
3. Campaigns and Settings > WhatsApp: the "Daily sending limit" card shows.
4. Templates > Create Template > Image header > pick a tall poster: the
   preview shows the whole picture.
5. Delete `api_image_test` afterwards.

Status: PENDING

## 18. Custom form builder
Deploy first (migration 108). Demo account, phone 9092766740 only.
1. Forms > New form. Expect "Blank form" selected, one question, and the
   preview on the right.
2. Name it "Wasi Custom". Change question 1 to "Student name". Add question
   > type "Multiple choice" > "Courses" > choices NEET, JEE, TNPSC. Add a
   "Phone number" question and a "Long answer" question (untick Required).
   Move "Courses" to the top with the up arrow. Delete one question.
   - Expect: the preview follows every change.
3. Create draft. Expect a Draft row and no "WhatsApp reported" line. If there
   is one, send me the text.
4. From 9092766740 send "hi", then in the chat: More actions > Send form >
   "Wasi Custom" > Send. Fill it in on the phone (tick two courses) and
   submit.
   - Expect: "Form submitted: Wasi Custom" in the chat, with the two courses
     as words (e.g. "NEET, JEE"), not codes. If you see codes like opt_1,
     tell me: Meta's format for multiple choice isn't documented.
5. Forms > New form > "Lead form": the lead questions appear and can be
   changed, moved or deleted like any other.

Status: PENDING

## 19. Template category changed by Meta (after deploy)
Deploy first (migration 109).
1. App Dashboard > WhatsApp > Configuration > Webhook fields: subscribe
   `template_category_update`.
2. Demo account > Templates > Sync. Any template Meta moved shows an amber
   "Meta changed the category from Utility to Marketing" note and
   "(was Utility)" in its footer. Category filter > "Changed by Meta" lists them.
3. The client whose templates were moved: Sync once on their account (or
   ask them to) so the notes appear.
4. If Meta later recategorises one, the card first says "Meta will change
   the category to Marketing on <date>", then the changed note.

Status: PENDING

## 20. Unapproved template is refused (after deploy)
Deploy first (migration 110).
1. In n8n (or any Hub API client), send a template that is still pending
   on the Templates page. Expect HTTP 409, code `template_not_approved`,
   message "... is still waiting for Meta's review". No message appears in
   the chat.
2. Send an approved template the same way - it still sends.
3. Campaigns > New campaign with the pending template - refused at create.

Status: PENDING

## 21. Marketing consent: account confirmation + n8n opt-in (after deploy)
Deploy first (migration 111). Demo account, test number 9092766740 only.
1. Settings > Compliance > Marketing consent: tiles show opted in / not
   recorded / opted out counts. Tick the box as the owner: "Confirmed by the
   account owner on <date>".
2. Send an approved Marketing template to 9092766740 (status not recorded):
   it sends. Untick the box and send again: refused with "has not opted in".
3. In n8n, send a Marketing template with
   `"optIn": {"method": "website_form"}` to 9092766740: it sends, and
   Contacts shows the number opted in.
4. Reply STOP from 9092766740, then send a Marketing template from n8n
   (with or without optIn): HTTP 409, code `contact_opted_out`, nothing in
   the chat. Reply START afterwards to undo it.
5. Log in as an Agent or Manager team member: the box is greyed out.

Status: PENDING
