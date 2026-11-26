# Marketing Messages API for WhatsApp (formerly MM Lite)

Status: Phase 1 built and verified locally (2026-11-26), against a faked
Meta. Live check pending (MANUAL_TESTS.md #24).

## Decisions (owner, 2026-11-26)
- Wasi accepted the MM API terms in the App Dashboard (2026-11-26). Meta's
  dialog also said: "you agree to share event activity data with Meta ... You
  can opt out at any time from Business settings."
- Rollout: per-client admin switch, off by default. Pilot: the Wasi demo
  client, switched on by an admin after deploy.
- `message_activity_sharing` is not sent, so each business's own setting in
  WhatsApp Manager applies (Meta's default after onboarding is to share).
- Not built from the plan: synchronous resend via /messages after an MM
  rejection (Meta's CLOUD_API_FALLBACK already covers not-onboarded; a stale
  local category fails visibly in Failed sends instead); client-facing
  Settings card (admin-only pilot first).
- MM calls pin `META_MM_GRAPH_API_VERSION` (default v24.0) instead of raising
  the global version.

## Purpose
Clients compare Wasi with AiSensy, which advertises "more reach" via Meta's
Marketing Messages API (MM API). Meta's own claim: up to 9% more marketing
messages delivered in India, for messages people engage with. It does NOT
remove the per-user marketing limit (131049) or the 250/day messaging tier.
Goal: let a client's Marketing templates go through MM API, and measure
whether delivery really improves. Do not promise the client a number.

Source: Meta docs read 2026-11-26 (onboarding, onboard-business-customers,
get-started, send-marketing-messages, changelog under
developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/).

## How Meta's side works (from the docs)
- Send: `POST /<PHONE_NUMBER_ID>/marketing_messages`, same template payload as
  `/messages`, plus `product_policy` (`CLOUD_API_FALLBACK` default, or `STRICT`)
  and `message_activity_sharing` (boolean). Marketing templates only.
- Not onboarded + `CLOUD_API_FALLBACK`: Meta sends it through Cloud API as
  today. So turning the route on can't make a send worse than now.
- Onboarding per client: a full-control admin accepts the MM API terms in
  WhatsApp Manager (Overview > Alerts > Accept terms), or new signups get the
  `marketing_messages_lite` Embedded Signup feature.
- Status: WABA field `marketing_messages_onboarding_status` (ELIGIBLE /
  ONBOARDED ...); webhook `account_update` with `event: MM_LITE_TERMS_SIGNED`.
- Status webhooks: unchanged shape; `pricing.category = marketing_lite` when
  it went through MM API, `marketing` when it fell back.
- Billing: per message, separate from Cloud API marketing. Rates not on the
  pages read. The client pays Meta directly, so their Meta bill changes.
- New error codes: 131062, 131063, 131065.

## Phase 0 - owner / Meta-side (no code, blocks Phase 1)
1. App Dashboard > WhatsApp > Quickstart > "Improve ROI with Marketing Messages
   API for WhatsApp" > Get started > request permission. The app already has
   advanced access to whatsapp_business_messaging/management (approved 7 Aug).
2. Confirm the Graph version: docs examples use v24+; our server defaults to
   `META_GRAPH_API_VERSION=v21.0`. Check what production sets.
3. Pilot client's full-control admin accepts the terms in WhatsApp Manager.
4. Check the send page's "Meta Pixel / Conversions API" prerequisite: unclear
   whether it applies to sending or only to insights.

## Phase 1 - build
- Migration: `wabas.mm_api_status text`, `wabas.mm_api_checked_at`,
  `wabas.mm_api_enabled boolean default false` (admin toggle);
  `messages.send_route text` ('cloud' | 'mm_api' | 'mm_api_fallback').
  `send_route` excluded from `metaWebhook.js` `enqueueForwards` (internal).
- `metaClient`: `getMarketingMessagesStatus(wabaId, token)`;
  `sendTemplateMessage` takes `{ route }` and posts to `/marketing_messages`
  with `product_policy: 'CLOUD_API_FALLBACK'`.
- `messagingService.sendChatMessage` (the one choke point for inbox, Hub API,
  n8n, Zapier, flows, broadcasts): MM route only when the template category is
  Marketing, `mm_api_enabled`, and `mm_api_status = ONBOARDED`. Everything else
  stays on `/messages`. Route stored in the retry queue's saved request.
- If `/marketing_messages` rejects the request outright (HTTP 4xx before
  acceptance, e.g. a template Meta now treats as Utility), send once more via
  `/messages` and log it. Never resend after Meta accepted a message.
- Webhook: `MM_LITE_TERMS_SIGNED` refreshes status (today `handleAccountUpdate`
  ignores payloads without `phone_number`); `pricing.category` on status
  updates records the real route.
- Admin Client Detail > WhatsApp: MM API status, "Check now", enable toggle.
  Failed-sends summary gains a route column.
- Client Settings > WhatsApp: status + how to accept the terms.
- Measurement: per client, delivered % and 131049 % by route, last 30 days,
  so the "more reach" claim is checked on our own data.
- Error map: 131062, 131063, 131065.

## Out of scope
Max-price bidding (`optimization_spec`), BSUID recipients, ad insights
(`ads_read`), creative optimisation settings, new-signup Embedded Signup flag
(Phase 2, after the pilot).

## Impact map
- `metaClient.js` send function: used by every template send; default route
  unchanged, so other callers are unaffected.
- `messagingService.js`: routing decision added; pacing, approval guard,
  consent guard unchanged and still run first.
- `messageRetryRunner.js`: replays stored requests; must replay the same route.
- `metaWebhook.js`: account_update and status handling; forward payload
  unchanged.
- `wabas` column grant: `wabas` has column-level SELECT grants (migration 013);
  new columns need a grant in the same migration plus a req.db read test.
- Client's Meta bill: different per-message price. Owner tells the client.

## Edge cases
- Template recategorised by Meta: route decided from the stored category at
  send time; outright rejection falls back once (above).
- Terms revoked / WABA restricted: status refresh flips it off; fallback policy
  covers the gap.
- 131049 still happens on MM API; no retry change here.
- Production token can't be decrypted locally: live checks run on the VPS.

## Acceptance criteria
1. Marketing template + enabled + ONBOARDED -> request goes to
   `/marketing_messages` with `product_policy: CLOUD_API_FALLBACK`.
2. Utility/Authentication/free text, or not enabled/onboarded -> `/messages`,
   byte-identical to today.
3. Outright rejection on MM -> one `/messages` send, logged; accepted MM send is
   never resent.
4. `MM_LITE_TERMS_SIGNED` webhook and "Check now" update `mm_api_status`.
5. Status webhook `pricing.category` sets `send_route` correctly.
6. Admin shows status/toggle; route column in failed sends; per-route delivery
   and 131049 rates.
7. Retry queue replays with the same route.
8. Live check on the pilot (MANUAL_TESTS): one marketing send arrives with
   `pricing.category = marketing_lite`.
