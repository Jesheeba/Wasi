# Unpaid signup block (2026-11-24)

## Purpose
Owner report: an account created without paying could use Wasi (it raised a
ticket and opened Campaigns). An account must pay before it can use anything.

## Rule
`services/serviceAccess.js` `serviceBlockReason(status)`:
- `pending_setup` (signed up, never paid) -> blocked, `payment_required`
- `suspended` -> blocked, `subscription_suspended` (unchanged)
- `payment_confirmed`, `active` -> allowed

Blocked accounts keep login (`/api/auth/*`) and billing (`/api/billing/*`)
so they can pay. Admin's Service toggle (status `active`) lets in an
offline-paying or trial client.

## Where it is enforced
- App routes: `requireActiveSubscription` (402 `{error}`), every client router except billing/auth.
- Hub API: `requireApiKey` (402 Hub error shape); `apiKeysRepo.findActiveByHash` now joins the client status.
- AI assistant: gate 1 (`gates.decide`) reason = the block reason.
- Not a send-level check: automations/flows/broadcasts need setup an unpaid account cannot make while blocked. Blocking sends for suspended clients is unit 0.5 (still waiting on the owner's resume/stop decision).

## Payment confirmation
- `services/subscriptionPayment.js` `confirmSubscriptionPayment` - shared by the Razorpay webhook and the new `POST /api/billing/verify-payment`.
- verify-payment: Razorpay's check, HMAC-SHA256(`order_id|payment_id`, `RAZORPAY_KEY_SECRET`), timing-safe; the order must be this client's subscription checkout (else 404); unblocks at once instead of waiting for the webhook. Idempotent with the webhook.
- `pending_setup` -> `payment_confirmed`. `suspended` -> `active` only when `auto_suspended_for_nonpayment` (same rule as admin "mark paid"); an admin's own suspension stays.

## UI
- Signup step 2: "Next" appears only after verify-payment succeeds; the old "continue testing without paying" paths are gone. A returning paid visitor skips to step 3.
- CRM app: `pending_setup` -> block screen "Complete your payment" (owner: choose plan and pay; team member: ask the owner). In-app checkout calls verify-payment and reloads when unblocked. Block screen shows the support email (tickets are blocked too).

## Impact / existing data (checked 2026-11-24, read-only)
- Every client that has ever sent a message is `active` or `payment_confirmed`: unaffected.
- Now blocked: Brainlit, Sirah, Evokz, Gardensip, Brivokz, jeshee (all `pending_setup`, none ever sent). Turn Service on in admin for any that should keep access.
- Tests: disposable clients registered via Node fetch are set `active` by `test/helpers/activateRegisteredClients.js` (preloaded by `npm test`); `x-test-keep-unpaid: 1` opts out. Run single files with `npm test -- test/x.test.js`, not bare `node --test`.

## Edge cases
- Payment succeeded but verify fails (network): the webhook still confirms; the page says so.
- Forged/malformed signature -> 400; another client's order -> 404; no state change.
- Razorpay not configured -> signup shows "payment isn't available", no way past.

## Acceptance (server/test/unpaidSignupBlock.test.js, googleLogin.test.js, clientSuspensionPaywall.test.js)
AC1 unpaid: auth/billing 200, app routes 402. AC2 Hub API 402 unpaid/suspended, 200 active. AC3 verify unblocks, subscription active, invoice paid, idempotent. AC4 forged/foreign rejected. AC5 webhook still unblocks. AC6 non-payment suspension lifted, admin suspension kept. AC7 AI off. UI: unpaid app shows payment screen; signup has no Next without payment.
