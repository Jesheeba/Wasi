# Testing

## ctwa-ad-metrics
`ctwaAdMetrics.test.js` (Meta faked), 8/8. `ctwaAdsPage.test.js` 6/6
after a deliberate change: the old "never show spend" check became "never
invent it" (no account connected -> "-" and no spend tile). ctwaConversions
5, metaAnalytics 4.

Port 4000 was held by a local `run-local.js` dev server, so the browser
suites were run on `127.0.0.2:4100` through temporary copies (deleted
afterwards). app.js only redirects API calls to :4000 for localhost and
127.0.0.1, so 127.0.0.2 stays same-origin.

## whatsapp-flows phase 3
`whatsappFlowsPhase3.test.js` (Meta faked), 6/6:
- Attribute map: an unknown field or a foreign attribute is 400.
- A completed form copies the choice as text into a text field and skips
  text into a number field.
- CSV header and row.
- Template: emoji 400; FLOW button with navigate + screen (and
  data_exchange for live forms); a `message_templates` row; a second one
  409.
- Sending outside 24 h: a pending template is refused with no call; an
  approved one goes out as the template with the flow-token button
  parameter.
- Bookings: listed, cancelled once, no longer counted.

The first run caught the booking date being shown a day early.
Regression, all green: whatsappFlows 17, flowLiveBooking 9,
chatsLastAgentReplyAt 17, metaWebhookDispatch 3, webhookForwarding 8,
productMessages 6, whatsappQuickWins 11.

## whatsapp-flows phase 2 (live booking)
`flowLiveBooking.test.js` (Meta faked, real RSA/AES encryption), 9/9:
- Config limits; open days, today excluded, capacity filtering.
- Flow JSON: data_api_version, routing model, data_exchange footers.
- Encryption round trip matches Meta's scheme.
- First live form uploads the key form-urlencoded, sets endpoint_uri, and
  stores the private key encrypted; the key is uploaded only once.
- Endpoint: unsigned 432, wrong key 421, ping, a foreign token 427; INIT
  date window; free slots only; booking -> SUCCESS with the chat linked; a
  taken slot is refused with the remaining slots.
- 3 simultaneous bookings of the last place: exactly 1 wins.
- Out-of-hours slots and past dates are refused.
- Chat send uses data_exchange with the chat in the token.

Regression, all green: whatsappFlows 17, whatsappFlowsUI 4,
productMessages 6, chatsLastAgentReplyAt 17, metaWebhookDispatch 3,
webhookForwarding 8, apiV1 14, whatsappQuickWins 11, woocommerce 13,
chatUiPass 15. chatUiPass first showed 2 failures, then a port-in-use
abort: the other Claude session was starting its own server on :4000
mid-run. A clean re-run passed 15/15.

## catalog-product-messages
`productMessages.test.js` (Meta faked), 6/6:
- Builder: product, list (deduplicated, 30 max, heading required, section
  titles), catalog; cart text.
- Catalog: non-numeric id 400; save; "find" with a Meta refusal 502 and a
  hint, and success.
- Send refused outside 24 h with no call; a list sent with the saved catalog
  and shown in the chat, recording a human reply.
- Bad input 400 before Meta; a failed send can't be retried.
- An incoming order is stored as readable text.

Regression, all green: whatsappFlows 17, woocommerce 13, woocommerceUI 3,
chatUiPass 15, chatsLastAgentReplyAt 17, metaWebhookDispatch 3,
webhookForwarding 8, whatsappQuickWins 11, apiV1 14.
## automation-rule-view-edit: live test on production (2026-11-23)
Migration 094 applied to production (only 094; `up 1`). Deployed with a
temporary lock (63572a3): demo-account rules replied only to 9092766740, and
`*` stayed dormant for every other client. Playwright (headed, owner logged
in as the demo account by hand; the harness aborted every send request)
created two rules through the UI. Real WhatsApp from 9092766740 to the demo
number: "Hi" at 13:46:15 IST got the catch-all reply at 13:46:18 (delivered,
read); "Dont understand what?" at 13:47:14 got no reply (24h throttle,
`chats.auto_reply_at` set). Both rules then deleted through the UI. Not
exercised live: the keyword rule (message not sent in the window; covered by
the automated tests). Lock removed afterwards by reverting 63572a3.

## ctwa-conversions
`ctwaConversions.test.js` (Meta faked), 5/5:
- No click id -> 409 with no call.
- A Meta refusal -> 502 and nothing recorded.
- The dataset is created once and stored; event payload as documented;
  a repeat is refused with no call.
- A sale needs an amount and sends value + INR, reusing the dataset.
- The list exposes hasClickId and conversions.

Regression, all green: ctwaAdsPage 6 (UI), metaAnalytics 4,
messageReferral 3.

## meta-analytics
`metaAnalytics.test.js` (Meta faked), 4/4:
- The exact `pricing_analytics` field syntax and the 7-day window.
- Category, free-message and per-day totals; the 11.78 rounding case (it
  failed first, then was fixed).
- A bad period falls back to 30 days; a Meta error gives 502 with its text.
- The template switch refused without confirm; then sent and recorded.
- 12 templates fetched in batches of 10 and summed; only `amount_spent`
  counted as cost.

`metaAnalyticsUI.test.js` (Playwright), 1/1: the cost tile and table; the
template tab's Turn on stays disabled until the box is ticked, then shows
numbers.

Regression, all green: analyticsTagsMultiTag 3, chatSlaLogs 10,
conversationPricing 7, ctwaAdsPage 6, messageReferral 3.

## whatsapp-quick-wins
`server/test/whatsappQuickWins.test.js` (API, Meta faked), 11/11:
- Read ticks: no inbound message -> no call; marks the newest inbound;
  typing adds the indicator; a Meta error still answers 200.
- Block: a 24h refusal (failed_users 131047) gives 409 with the reason and
  marks nothing; block/unblock use POST/DELETE with "+phone" and track
  state.
- QR: 141 characters -> 400 with no call; create stores the image URL;
  edit; delete works even when Meta already removed the code.
- Starters: read mapping; 5 prompts, emoji and duplicate commands are
  refused before Meta; "/hours" is saved as "hours".
- Green tick: status; 4 links -> 400; fields mapped; app-registered
  numbers are refused.
- request_welcome -> "Opened the chat"; role gates.

`whatsappQuickWinsUI.test.js` (Playwright), 2/2: opening a chat sends one
read call; typing is throttled to one indicator; Block via the menu flips
to Unblock; QR create shows the image and link; starters save the right
Meta body; green-tick status and form shown.

Regression, all green: chatUiPass 15, settingsRedesign 11,
confirmPromptGroup23 6, modalInnerScrollGroup4 4, chatsLastAgentReplyAt 17,
metaWebhookDispatch 3, webhookForwarding 8, coexistenceEchoIngestion 9,
whatsappFlows 17, whatsappFlowsUI 4, apiV1 14.

## woocommerce-integration
`server/test/woocommerce.test.js` (fake store + fake Meta via global.fetch,
fake DNS via publicUrl.resolver, local Postgres), 13/13:
- Phone normalisation (Indian local, 0-prefixed, international, refusals);
  triggers, fields, param mapping (empty -> "-").
- AC5: http, localhost, 127.x, 169.254.x, a host resolving to 10.x, and
  credentials in the URL are all refused, with no request made.
- Connection: bad keys 502 and leave nothing; keys connect sends Basic auth
  with redirect: 'error', creates 2 webhooks with our delivery URL and a
  secret, and stores keys encrypted; no secret in the response; a second
  store is refused (409).
- AC4: rules refuse Marketing, pending and unmapped templates; unknown keys
  are dropped.
- Webhooks: ping 200; bad signature 401 with nothing stored.
- AC2: order placed sends the template to 9198... with mapped params and
  creates the contact.
- AC3: duplicate sends nothing; no rule is logged; an unusable phone and a
  STOP'd contact are skipped with a reason.
- Page data has no secrets; one-click callback connects and the token is
  single-use; disconnect removes both webhooks.

The first runs caught the `.end()` commit trap (see CHANGELOG).
`woocommerceUI.test.js` (Playwright), 3/3: private URL error shown, keys
connect, rule drawer offers only approved Utility templates and auto-maps
same-named variables, a signed event shows as Sent, disconnect, the
Integrations card, 375px.

Regression, all green: integrationsPage 5, comingSoonPages 3, ctwaAdsPage
6, whatsappFlows 17 (+2 commit assertions, mutation-checked against
`.end()`), whatsappFlowsUI 4, chatUiPass 15, settingsRedesign 11, apiV1
14, webhookForwarding 8, metaWebhookDispatch 3, consentHardeningPhase1 8,
chatsLastAgentReplyAt 17, apiKeysSelfServe 9.

## whatsapp-flows
`server/test/whatsappFlows.test.js` (API, Meta faked via global.fetch,
local Postgres): builder output (7.3, complete footer, `${form.x}`
payload, opt ids), limits and duplicate/empty options, token round-trip;
create sends LEAD_GENERATION + inline JSON; bad wording 400s with no Meta
call; Meta validation errors stored and block publish; draft edit uploads
multipart flow.json; send refused outside 24h; draft sends with mode draft
and our token and sets last_agent_reply_at; emoji CTA rejected; failed
form retry -> cannot_retry_form with no send; publish -> edit 409 ->
duplicate copies wording; published sends without draft mode; delete rules
(published 409, retired local-only, draft deletes on Meta); nfm_reply ->
readable message + one response despite redelivery; malformed reply still
stored. 17/17 (first run caught answers coming back in jsonb key order).
`whatsappFlowsUI.test.js` (Playwright): empty state, booking form with live
preview, payload sent to Meta, publish via confirm (Duplicate replaces
Edit), wording errors shown in the drawer, chat Send form, 375px fit. 4/4.
Regression: chatsLastAgentReplyAt 17, metaWebhookDispatch 3,
metaWebhookEchoRouting 9, webhookForwarding 8, apiV1 14,
coexistenceEchoIngestion 9, messageReferral 3, consentHardeningPhase1 8,
chatUiPass 15, flowEngine* 29, aiAgentEnqueue 7, chatSlaLogs 10, all green.

## automation-rule-view-edit: audit fixes
Bugs A and B reproduced first against local Postgres (flow delete: check-
constraint error; `*` vs a normal message: not handled). Added 6 tests to
`server/test/automationRuleViewEdit.test.js`: H whole-word/phrase/Tamil
matching; B catch-all after keyword rules, once per 24h, again after 24h;
B never inside a flow, claim released on a failed send; A flow delete 204
and its rule gone; I+F delete 204/404, bad id 400 on DELETE and PATCH, blank
trigger 400, other client's rule 404; D+G+I UI draft-flow badge and drawer
warning, duplicate-keyword warning, delete from drawer. 12/12. Sends are
stubbed; nothing reaches Meta. Regression (every suite touching rules,
flows or the engine): aiAgentEnqueue 7, broadcastTagAudienceMultiTag 4,
chatSlaLogs 10, chatsLastAgentReplyAt 17, consentHardeningPhase1 8,
contactTimeline 4, flowEngine 19, flowEngineCaptureReply 6,
flowEngineCaptureReplyEndToEnd 4, flowEngineOutcome 17, flowEngineRunToRest
3, mediaHeaderService 11, metaWebhookEchoRouting 9, settingsRedesign 11,
templateLanguageHardcodeFixes 4, templateParamMapping 12,
confirmPromptGroup23 6 - all pass. api 12/13: the one failure is the known
stale onboarding test (unstubbed listPhoneNumbers, see CLAUDE.md), unrelated.

## integrations-page
`server/test/integrationsPage.test.js` (Playwright + API, :4000, local
embedded Postgres): AC1/AC4 status reflects seeded key, webhook, Zap,
deliveries (newest wins; webhook vs Zapier told apart by URL) and payment
links, with no secret/hash/raw key/URL in the body; empty client all-off;
AC5 Admin/Manager gate + Agent nav hidden; AC1-3 UI badges (Failing,
Connected, Coming soon), Shopify has no button, Manage/Create key/Open
Payments navigate to the right section; empty client sees Not set up + the
connect-WhatsApp notice. 5/5 (first run caught the notice always showing).
Regression: apiKeysSelfServe 9/9, apiV1Subscriptions 6/6, webhookForwarding 8/8.

## ctwa-ads-page
`server/test/ctwaAdsPage.test.js` (Playwright + API, :4000, local embedded
Postgres): AC2 leads are distinct chats, totals don't double count across
ads, organic excluded, 30-day range filters, bad `since` 400s; AC3 chats per
ad incl. an ad with no source_id/headline; AC6 empty client zeros + tenant
isolation; AC5 route sits behind the Admin/Manager gate; AC1-4 UI: nav,
tiles, range, `javascript:` ad link not rendered, drill-down, Open chat lands
in Chat; AC6 UI empty state. 6/6. Mobile 375px checked by screenshot (cards
stack, no overflow). Regression: comingSoonPages 3/3, messageReferral 3/3,
analyticsTagsMultiTag 3/3, chatSlaLogs 10/10, conversationPricing 7/7,
teamMemberAuth 12/12, chatUiPass 15/15.

## automation-rule-view-edit
`server/test/automationRuleViewEdit.test.js` (Playwright + API, :4000, local
embedded Postgres via TEST_DATABASE_URL, disposable clients deleted in
after(), no WhatsApp send - engine test stubs messagingService). AC1+2 row
opens a prefilled drawer, full reply in the bubble, live preview, edit
PATCHes (no duplicate row); AC3 table switch disables, persists across
reload, re-enables, never opens the drawer; drawer switch saves Disabled on
create; AC4 disabled rule not matched by automationEngine; AC5 action/flow_id
stay exclusive both ways, both at once 400, status 'Active' 400; AC6 another
client's flow_id 400. 6/6 pass first run. Screenshots at 1440 + 375 found the
sixth "View" column clipped off the card at 1440, so it was dropped (the row
opens the drawer), and the one-line reply input became a textarea; re-run
6/6. Regression (`.wasi-toggle` moved to design-system.css, Create Rule
drawer changed): settingsRedesign 12/12, adminUiRedesign 9/9,
adminSummaryRedesign 4/4, confirmPromptGroup23 6/6, modalInnerScrollGroup4
4/4.

## coming-soon-pages
`server/test/comingSoonPages.test.js` (Playwright, :4000, local embedded
Postgres): each of the 5 pages has a nav entry with a Soon badge, opens on
click, updates the hash and says coming soon; none of the old fake figures
remain in index.html; Flows/Ads/Ecommerce/Integrations are in the Agent
hidden list, Instagram is not. 3/3. Regression: adminUiRedesign 9/9,
chatUiPass 15/15, settingsRedesign 12/12, confirmPromptGroup23 6/6,
modalInnerScrollGroup4 4/4.

## settings-forms-admin-redesign (steps 1-6, complete)
`server/test/settingsRedesign.test.js` (Playwright, :4000, local embedded
Postgres via TEST_DATABASE_URL, disposable client deleted in after()):
tags inline add saves the chosen colour and never opens the modal (AC4);
canned drawer live preview, Escape-with-input asks, Cancel keeps text,
Discard clears, clean drawer closes without asking (AC5/6); attribute saves
as `number` (the 400 fix, AC8); 375px no overflow + full-width drawer
(AC9). Step 3: wallet chips set amount + aria-pressed, quick recharge
POSTs {amount_inr} through the existing form (AC2); all plans rendered,
Choose pre-selects in checkout (AC3); billing tiles + empty state. 375px
check covers all nine sections. Step 4: invite POSTs the role picked from
the cards (Agent), row + tiles update; webhook form-when-unset, secret stays
visible after first save, summary after reload, Edit/Cancel restores; not-
connected WhatsApp shows the guide with tabs hidden. 11/11 pass. Message
Link builder not browser-tested (needs a connected WABA locally).
chatUiPass re-run 15/15. Step 5: all 7 converted pop-ups are drawers; Add
Contact 201s from the drawer, payment link POSTs the same body with no
gateway field, Create Rule saves and lists. confirmPromptGroup23 caught a
real regression (API-key button hidden) from the page-wide inner-tab
handler; fixed + covered by the WhatsApp test. 12/12 + confirmPromptGroup23
+ modalInnerScrollGroup4 = 22/22. Step 6:
`server/test/adminSummaryRedesign.test.js` - tile counts match the API and
filter (status + unpaid, dropdown clears unpaid), a populated onboarding
stage filters to its exact count, invite drawer sends the card's role
(POST intercepted, no admin row written), client strip has 5 tiles. 4/4.
adminUiRedesign 9/9. Needs TEST_ADMIN_PASSWORD=dev-only-admin-password
against the local DB. Regression: chatUiPass 15/15 (needs JWT_SECRET set; it
doesn't load .env), confirmPromptGroup23 + modalInnerScrollGroup4 pass.
errorDialogUI test 2 fails identically on the pre-change tree (it predates
the template type picker, 88bc697) - stale test, not a regression.

## flow-editor-shared-tokens
`server/test/flowEditorSharedTokens.test.js` (static, no DB): the editor links
`/breakpoints.css`; every shared-palette `--wf-*` is `var(--token, fallback)`;
no literal colour outside the `:root` block or in the JSX/constants; the app
serves `/breakpoints.css` and the Dockerfile ships it. 4/4 pass; mutation check
(re-adding one `#F9FAFB`) fails the suite as expected. Live check: `createApp()`
on :4000 + Playwright, `/flow-editor/` loads the shared sheet, `--wf-accent` =
`#4AC959`, and overriding `--brand` turned `.wf-btn-primary` red.

## carousel-templates
`server/test/carouselTemplates.test.js` - real DB writes through a
disposable test client (same pattern as `limitedTimeOfferTemplates.test.js`);
every Meta call (createUploadSession/uploadFileBytes/uploadMedia per card +
message_templates) stubbed. Mapped to the feature doc's acceptance criteria:

| Test | Criterion |
|---|---|
| 1-card carousel rejected locally (400) | #2 |
| Mismatched card button shapes across cards rejected locally (400) | #2 |
| Non-Marketing category rejected locally (400) | #2 |
| Header alongside a carousel rejected locally (400) | #2 |
| Card file count must match card count (400), no Meta call | #2 |
| Valid 2-card carousel submits with the documented lowercase `body`/`carousel`/`header`/`buttons` shape (not this app's usual uppercase); one media upload per card; local row stores `cards` with no transient `headerHandle`; one default media asset cached per `card_index` | #1 |
| Sending resolves one media id per card and sends a `carousel` component with per-card `card_index` + header | #3 |

Result: 7/7 pass. Regression: re-ran the full template/broadcast/consent
impact map (`limitedTimeOfferTemplates`, `templateEdit`,
`templateMediaAssets`, `templateSync`, `templateLibrary`,
`templateCategoryMismatchWarning`, `templateLanguageHardcodeFixes`,
`consentTracking`, `consentHardeningPhase1/2`, `optInKeywordPhase4`,
`apiV1AuthenticationTemplateSend`, `broadcastRetry`, `broadcastPacing`,
`broadcastSmartSending`) - 111/111 pass, all pre-existing ones unaffected.

**Known gap, documented not hidden**: `POST /:id/header-media` (uploading
a NEW media asset to an existing template after creation) is not yet
card-aware - only the creation-time per-card upload path works. A
carousel template's card media can only be set at creation; re-uploading
a card's image later needs a future pass, same two-pass history this
app's single-header media-asset feature itself had (`templateMediaAssets.test.js`'s
whole premise). Not a blocker for the acceptance criteria above - just
not built yet.

**Frontend scope note**: the create-modal's per-card editor supports one
optional URL button per card (not the full QUICK_REPLY/PHONE_NUMBER mix
Meta allows) - matches the common "image + text + link" pattern from the
reference screenshot, deliberately simpler than building two full button
editors for a first pass.

## fix(cross-tab-tenant-isolation)
`server/test/crossTabTenantIsolation.test.js` - real browser (Playwright),
two tabs sharing one context/storage, against `wasi-test-postgres`
(port 5433), served on port 4005 with `page.route` redirecting app.js's
hardcoded `:4000` API calls (port 4000 was already held by the user's own
locally-running dev server, left untouched per project convention).

| Test | Criterion |
|---|---|
| Tab A open on account A; tab B (auto-resumes A via shared storage) logs out and into account B | Tab A gets forced back to the login screen, never renders B's data under A's chrome |
| Tab B performing the switch | stays logged in as B, unaffected |
| Tab B re-authenticates as the SAME account with a fresh token (no logout) | Tab A is NOT kicked out - decoded tenant id still matches |

2/2 pass. `confirmPromptGroup23.test.js` (the other test that also
hardcodes port 4000) could not be re-run in this session for the same
pre-existing port-4000 collision already documented in the
limited-time-offer-templates entry above - unrelated to this change, no
diff on that file.

## client-suspension-paywall
`server/test/clientSuspensionPaywall.test.js` - stubs only (no DB), same
discipline as `sessionInvalidation.test.js`. Mapped to the feature doc's
acceptance criteria:

| Test | Criterion |
|---|---|
| `requireClientAuth`: active/suspended owner both pass, `req.clientStatus` set | widened select doesn't self-block (billing/auth-me depend on this) |
| `requireClientOrTeamAuth`: owner branch sets status from `clients` | #2 |
| `requireClientOrTeamAuth`: team_member branch sets status from the JOINED owning client, not the team member | #3 |
| `requireActiveSubscription`: active passes | #4 |
| `requireActiveSubscription`: `pending_setup` passes (explicitly not gated) | scope decision in feature doc |
| `requireActiveSubscription`: `suspended` → 402 `subscription_suspended` | #1 |

Result: 7/7 pass. Run: `node --test --test-concurrency=1 test/clientSuspensionPaywall.test.js`.

Also re-ran `sessionInvalidation.test.js` (unchanged, 10/10 pass) as the
regression check for `requireClientAuth`/`requireClientOrTeamAuth`, since
those two files were edited directly.

**Known gap, not caused by this feature**: `teamMemberAuth.test.js` and the
other 67 files using `createApp()` for a real HTTP+DB round trip currently
fail under `npm test` - `dbSafety.js`'s guard refuses any DB connection
under a test context without `TEST_DATABASE_URL`, which this project
doesn't have yet. Pre-existing, already tracked
(`project_orphaned_test_clients_cleanup` memory). This meant criteria #5
(live session torn down mid-use) and the full owner/team-member HTTP flow
couldn't be exercised end-to-end here - covered at the middleware-unit
level only, consistent with the one test style that currently works in
this repo.

**Update, 2026-11-16**: this gap is now closable locally - stood up a
disposable local Postgres 17 via `docker run ... postgres:17-alpine` on
port 5433 (exactly `.env.example`'s documented recipe), ran
`node-pg-migrate up` + `db/seed.js` + `db/seedTemplateLibrary.js` against
it, then `npm test` with `DATABASE_URL`/`TEST_DATABASE_URL` both pointed at
it (plus `TEST_ADMIN_PASSWORD` overridden back to the seed default - the
committed `.env`'s `TEST_ADMIN_PASSWORD` is the real rotated production
admin password, which doesn't exist on a fresh local seed). The full
`createApp()`-based suite (101 files) runs for real against this, not just
the stubs-only style. The container isn't part of this repo/commit - it's
a one-off local tool, recreate with the same docker command whenever a
real DB-backed test run is needed.

## limited-time-offer-templates
`server/test/limitedTimeOfferTemplates.test.js` - real DB writes through a
disposable test client (same pattern as `templateMediaAssets.test.js`);
every Meta call stubbed. Run against the local test Postgres above (migrations
091/092 applied there first). Mapped to the feature doc's acceptance criteria:

| Test | Criterion |
|---|---|
| LTO + non-NONE header rejected locally (400), no Meta call | #2 |
| LTO offer text over 16 chars rejected locally (400) | #2 |
| LTO coupon code over 15 chars rejected locally (400) | #2 |
| LTO with no coupon code rejected locally (400) | #2 |
| LTO + footer rejected locally (400), no Meta call | #2 |
| LTO on a non-Marketing category rejected locally (400) | #2 |
| Valid Marketing + LTO (no header) submits to Meta with a `LIMITED_TIME_OFFER` component AND the Meta-required `COPY_CODE` button (`example` = the literal code, not the strip text); local row stores `limited_time_offer` | #1 |
| Sending with `hasExpiration` requires `limitedTimeOfferExpirationMs`; valid value forwarded to Meta as `expiration_time_ms` + the required `copy_code` button component | #3, #4 (via `limited_time_offer_expiration_required` rejection) |

Result: 8/8 pass (grew from an initial 5/5 - 3 more added after a real
Meta submission caught 2 real bugs the stubbed tests couldn't: see the
feature doc's "Correction after real Meta submission" section). Regression:
re-ran every file in the feature doc's impact map plus the template/
broadcast/consent suites most likely to interact - `templateEdit`,
`templateMediaAssets`, `templateSync`, `templateLibrary`,
`templateCategoryMismatchWarning`, `templateLanguageHardcodeFixes`,
`consentTracking`, `apiV1AuthenticationTemplateSend`, `broadcastRetry`,
`broadcastPacing`, `broadcastSmartSending` - 82/82 pass (incl. the 8 LTO
tests), all pre-existing ones unaffected by this change.

Also ran the full 101-file suite once as a final check: 767 tests, 753
pass, 13 fail, 1 skipped. All 13 failures are in files this feature never
touched (confirmed via `git status` - zero diff on any of them) and none
are in the impact map above:
- 11 UI test files (`adminUiRedesign`, `broadcastPauseResumeUI`,
  `chatUiPass`, `confirmPromptGroup23`, `errorDialogUI`,
  `marketingBannersGroup5`, `modalInnerScrollGroup4`, `modalScrollGroup1`,
  `segmentBuilderUI`, `smartSendingUI`, `templateLibraryUI`) all fail with
  the identical pre-existing cause: `app.listen(4000)` (not `listen(0)`
  like the properly-isolated tests) collides with an unrelated process
  already bound to port 4000 on this machine (confirmed via `netstat`/
  `Get-Process` - a node process started independently of this session,
  left untouched rather than killed without knowing what it is).
- 2 subtests (`api.test.js`'s coexistence onboarding case,
  `embeddedSignupConnectRuntime.test.js`'s runtime-1 case) fail with a
  502 instead of 200 - both about WhatsApp Embedded Signup/Coexistence
  connection flows, unrelated to templates/broadcasts/messaging, not
  investigated further here (out of this feature's scope).
