# Questions for the team — answers needed before certain gaps can close

Companion to `GAP_FIX_PLAN.md` (code work) and `GO_LIVE_CHECKLIST.md` (the existing
Meta/Razorpay account checklist this draws from). Each question below blocks either a
specific phase in the fix plan, or a go-live checklist item that only a human with the
right access/authority can answer. Fill in the **Answer** line under each and hand
back — no need to answer in order, but items marked **Blocks: Phase X** should come
back before that phase starts.

---

## A. Meta / WhatsApp account status

### A1. Meta Business Verification — current status?
`GO_LIVE_CHECKLIST.md` §1 lists this as the single longest step (1–5 business days,
sometimes needs resubmission) and says to start it first. Has it been started? If so,
what's the current state — submitted, in review, approved, rejected/resubmission
requested?
**Blocks:** onboarding any real client beyond the current test WABA.
**Answer:**

### A2. Meta App Review — submitted yet? (docs contradict each other — resolve this one first)
`wasi-build-plan.md` (line 5) states the Meta app (`27135450269410430`) is already
**"Tech Provider verified, both WhatsApp permissions at Advanced access, app
published, no reviews pending."** But `GO_LIVE_CHECKLIST.md` §1 — written to be *the*
checklist of what's still outstanding — lists **"create a Meta Business Manager if
you don't have one"** and **"Submit for App Review"** as unchecked, open steps. Those
two claims can't both be current. Whoever has Meta App Dashboard / Business Manager
access: which is actually true today — is App Review done and the checklist stale,
or is verification/review still pending and the build-plan note is the stale one?
**Blocks:** every other Meta-related answer in this file depends on knowing which
document reflects reality — get this one first.
**Answer:**

### A3. Embedded Signup — who can do a real end-to-end test run?
`wasi-build-plan.md` §6.2 flags that the actual client-facing onboarding flow
(`FB.login()` popup → `/api/onboarding/whatsapp/connect`) has **never been run with a
real Meta test user** — every verification so far pasted WABA credentials directly
into the database. This has to be run live, by someone with a Meta test-user account
and access to the app dashboard's test WABA. Who can do this, and when?
**Blocks:** trusting the onboarding flow before a real (non-test) client uses it;
also blocks Phase C2 in the fix plan (self-signup API keys), since that assumes
clients are actually reaching the app through this path.
**Answer:**

### A4. `message_template_status_update` webhook — re-check subscription?
During Phase 2 verification, this specific webhook field was subscribed in the Meta
App Dashboard and a template was approved during the test window, but **zero**
`message_template_status_update` POSTs arrived (confirmed via ngrok request logs, not
inferred). The dispatch code is implemented and tested against a captured payload
shape, but has never actually received a real delivery. Can whoever has App Dashboard
access re-check the field subscription, re-subscribe, or open a Meta support case?
**Blocks:** trusting template-approval notifications in production; also blocks
Phase C1 (delivery/read receipt forwarding) if the underlying dispatch mechanism is
still unproven for this event type.
**Answer:**

### A5. Default webhook — when to switch from the CRM to Wasi?
Meta allows one default webhook URL per app; it currently points at the Sirah CRM.
`wasi-build-plan.md` Phase 7 says: switch it to Wasi only after Phases 1–5 are
verified working, keep an override on the CRM's WABA so it keeps receiving its own
messages (or migrate the CRM to consume Wasi's Hub API and drop its direct Meta
code). Which approach do we want — override-and-keep-both, or migrate the CRM off
direct Meta entirely? Who owns making the actual switch and confirming both still
send/receive afterward?
**Answer:**

---

## B. Razorpay / billing

### B1. Razorpay live account — KYC status?
`GO_LIVE_CHECKLIST.md` §2 requires a Razorpay business account with completed KYC
(PAN, bank account, business documents) before live-mode keys can be generated. Has
this been started? Target date?
**Blocks:** accepting any real payment.
**Answer:**

### B2. Recurring billing — Razorpay Subscriptions, now built as a placeholder
**Decided and built.** Chose Razorpay's real Subscriptions product over an
in-house re-billing scheduler. Since no Razorpay account/keys exist in this
environment yet, it's built the same way Phase D1 handled an equivalent gap: fully
additive and inactive by default (`plans.razorpay_plan_id` is null for every plan,
so checkout/cancel behave exactly as before until that changes), with the real
Subscriptions API calls (`razorpayClient.createSubscription`/`cancelSubscription`)
and webhook handling (`subscription.activated`/`.charged`/`.cancelled`/`.completed`/
`.halted`) written but **unverified against a live account** — inferred from
Razorpay's documented API/webhook shapes only.
**What's actually needed now, in order:**
1. A live Razorpay account with Subscriptions enabled (may need requesting access —
   not every account has it by default).
2. One real Plan created per pricing tier (Starter/Growth/Scale) in the Razorpay
   dashboard or via their API — each yields a `plan_id`.
3. Set `plans.razorpay_plan_id` to each real `plan_id` (a direct DB update, no code
   change needed).
4. Register the new `subscription.*` webhook events in the Razorpay dashboard
   alongside the existing ones already in `GO_LIVE_CHECKLIST.md` §2.
5. Run one real subscription create → webhook charge → cancel cycle end to end
   before trusting it with a real client.
**Answer (once you have the real Razorpay key, share it and I'll wire it through
`.env` and confirm the flow works):**

### B3. Confirm current plan pricing is real
`GO_LIVE_CHECKLIST.md` §2 asks to confirm the `plans` table (migration
`008_billing.js`) reflects real intended pricing before any client checks out live.
Has this been reviewed against current pricing intentions?
**Answer:**

---

## C. Infrastructure / operations

### C1. Error tracking — which provider, and who creates the account?
**Update: the code side of Phase B2 is now built and merged** —
`server/src/utils/errorTracking.js` is wired against `Sentry`'s Node SDK
specifically (already added to `server/package.json`) and reads `SENTRY_DSN` from
env, degrading to a safe no-op with it unset (confirmed by a live smoke test). What's
still needed is the account itself: someone needs to actually create a Sentry
project and hand over the DSN — or say if a different provider (Bugsnag, Rollbar,
Datadog) is preferred instead, in which case the SDK call in `errorTracking.js`
would need swapping, not just the env var. Who sets this up?
**Blocks:** nothing code-side anymore — this only blocks the integration actually
reporting anything in production.
**Answer:**

### C2. External uptime monitoring — which service?
`wasi-build-plan.md` §6.1 is explicit that this is the minimum viable fix for the
biggest operational risk in the repo: nothing currently notices if the process
crashes, and Meta discards undelivered webhooks permanently after 7 days with no
replay. This needs a third-party service polling `/health` from outside Render
(UptimeRobot, Better Uptime, Pingdom, etc.) with alerting to email/SMS/Slack. Which
service, who sets up the account, and who's the on-call contact for the alert?
**Blocks:** nothing code-side — this is pure account setup, can happen anytime,
should happen soon given the severity above.
**Answer:**

### C3. Render restart behavior — has anyone actually verified it?
Same section notes this is inferred from Render's documented behavior and tool
defaults, never empirically confirmed by killing the process and timing recovery.
Can someone with Render dashboard access do this once (kill the running process,
time how long until it's back and serving `/health`)?
**Answer:**

### C4. Supabase backups / point-in-time recovery — actually enabled?
`wasi-build-plan.md` §0.4 asks to confirm this is genuinely enabled for the Wasi
Supabase project, not just assumed, before onboarding any real client — and to take
a manual snapshot before the first production migration after a client goes live.
Can whoever has Supabase project access confirm the current backup/PITR
configuration?
**Blocks:** onboarding real clients with confidence in recoverability.
**Answer:**

### C5. Token secret store — Supabase Vault, AWS KMS, or something else?
**Update: built already, using Supabase Vault** — didn't block on this answer since
the plan itself already named Vault as the path of least resistance. `encryption.js`
is now pluggable (`SECRET_STORE` env var) with a working Supabase Vault backend
(`server/src/utils/secretStores/supabaseVaultStore.js`) alongside the original
default. It is **not yet verified against a real Supabase Vault instance** — nothing
in local dev or CI can do that (Vault only exists on a Supabase project with it
enabled, not on plain Postgres) — so before this actually gets turned on in
production, someone needs to: (1) confirm Vault is enabled for the real Supabase
project, (2) run `server/scripts/rotate-secret-store.js` in dry-run mode against it,
(3) confirm a real decrypt succeeds, before flipping `SECRET_STORE=supabase_vault`
for real traffic. If AWS KMS or something else is actually preferred instead, that's
a new `secretStores/` module and a swap in `encryption.js`'s backend map, not a
redo of this phase.
**Blocks:** nothing code-side anymore. Blocks only the actual cutover to a non-default
store — the app runs exactly as before with `SECRET_STORE` unset.
**Answer:**

### C6. Repo GitHub admin access — who sets branch protection?
Once Phase A1 (CI workflow) is green, someone with GitHub repo admin rights needs to
turn on "require status checks to pass before merge." Who has that access on
`github.com/Jesheeba/Wasi`?
**Answer:**

---

## D. Legal / compliance

### D1. Privacy Policy & Terms of Service — real counsel-reviewed text
`GO_LIVE_CHECKLIST.md` §1 flags that `/marketing/privacy.html` and
`/marketing/terms.html` currently have placeholder legal text and need real,
counsel-reviewed copy before Meta App Review submission (both URLs get linked in the
App Dashboard). Who's engaging counsel for this, and by when?
**Blocks:** Meta App Review submission (A2 above).
**Answer:**

### D2. Data deletion / consent policy specifics
The opt-in/consent system (`wasi-build-plan.md` Phase 4) auto-detects STOP-type
messages including "best-effort, not native-speaker-verified" Tamil/Tanglish
variants. Is there a compliance/legal review needed on the actual consent policy
logic (what counts as opt-out, retention of `consent_events`, etc.) beyond the
current best-effort implementation?
**Answer:**

---

## E. Product scope decisions

These aren't blockers for anything in Phase A–D of the fix plan, but two items in
Phase E have real architectural forks that shouldn't be started on a guess:

### E1. Team inbox — full per-agent login, or attribution-only?
`GAP_FIX_PLAN.md` Phase E2 flags this: does each team member need their own login
(separate auth, ~4-5 days) or is "who's this chat assigned to" enough without
individual per-agent authentication (~1.5 days)? What's actually being sold/promised
to clients on this feature?
**Blocks:** Phase E2 start.
**Answer:**

### E2. Which Phase F integrations (if any) are actually wanted?
Ecommerce catalog, Meta's own WhatsApp Flows product, Instagram DM automation, CTWA
config — all currently static/decorative by deliberate scope decision. Is there a
specific client asking for any of these, or should they stay deferred?
**Answer:**
