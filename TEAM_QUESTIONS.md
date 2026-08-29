# Questions for the team — answers needed before certain gaps can close

> **Provenance note (2026-08-28):** this file was originally written on the
> `origin/gap-fixes-a-e` branch (2026-08-25) alongside a companion
> `GAP_FIX_PLAN.md` describing code-side work for many of these items. That
> branch was never merged into `master` and has since diverged significantly
> (26 independent commits on `master` vs. 4 on the branch) — several of its
> "done" claims below do NOT reflect current `master`, corrected inline
> where found. The original `GAP_FIX_PLAN.md` is NOT reproduced here (it's
> long and several of its claims are stale in the same way) — see
> `git show origin/gap-fixes-a-e:GAP_FIX_PLAN.md` for the full original, and
> this repo's `CLAUDE.md` Known Gaps section for what's actually true on
> `master` today for each item that branch claims to have built.

Companion to `GO_LIVE_CHECKLIST.md` (account-side) and (originally)
`GAP_FIX_PLAN.md` (code work, see note above). Each question below blocks
either a specific phase, or a go-live checklist item that only a human with
the right access/authority can answer. Fill in the **Answer** line under
each and hand back — no need to answer in order, but items marked
**Blocks:** should come back before that thing starts.

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
also blocks client self-signup API key generation, since that assumes clients are
actually reaching the app through this path (note: self-serve API key generation
itself now exists on `master` — see C2 below — this dependency is about the
onboarding flow it assumes clients arrive through, not the key feature itself).
**Answer:**

### A4. `message_template_status_update` webhook — re-check subscription?
During a past verification pass, this specific webhook field was subscribed in the
Meta App Dashboard and a template was approved during the test window, but **zero**
`message_template_status_update` POSTs arrived (confirmed via ngrok request logs, not
inferred). The dispatch code is implemented and tested against a captured payload
shape, but has never actually received a real delivery. Can whoever has App Dashboard
access re-check the field subscription, re-subscribe, or open a Meta support case?
**Blocks:** trusting template-approval notifications in production.
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

### B2. Recurring billing — real Subscriptions API, still fully unbuilt on master
**Correction (2026-08-28):** `GAP_FIX_PLAN.md`'s original text here claimed this was
"decided and built" (Razorpay's real Subscriptions product, additive/inactive by
default). That work exists **only on the unmerged `origin/gap-fixes-a-e` branch** —
`master` has none of it: `invoicesRepo.createPaid`, `plans.razorpay_plan_id`,
`subscriptions.billing_mode`, and the `subscription.*` webhook handling do not exist
here today. `master`'s current `POST /cancel` still just flips a local DB flag, as
described in the original "Why" below. Rebuilding this against current `master`
(not reconciling the branch's version, which has drifted) is real, scoped work for
a future phase if this is still wanted.
**What's actually needed, in order, before anything like this can activate:**
1. A live Razorpay account with Subscriptions enabled (may need requesting access —
   not every account has it by default).
2. One real Plan created per pricing tier (Starter/Growth/Scale) in the Razorpay
   dashboard or via their API — each yields a `plan_id`.
3. Build (or reconcile from the branch) the `razorpay_plan_id`/`billing_mode` schema
   and webhook handling described in the branch's `GAP_FIX_PLAN.md` Phase E4 — treat
   it as a design reference, not a diff to merge as-is (master's own `invoicesRepo.js`
   and `razorpayWebhook.js` have changed independently since).
4. Register the new `subscription.*` webhook events in the Razorpay dashboard
   alongside the existing ones already in `GO_LIVE_CHECKLIST.md` §2.
5. Run one real subscription create → webhook charge → cancel cycle end to end
   before trusting it with a real client.
**Answer (once you have the real Razorpay key, share it and this can be wired
through `.env` and confirmed working):**

### B3. Confirm current plan pricing is real
`GO_LIVE_CHECKLIST.md` §2 asks to confirm the `plans` table (migration
`008_billing.js`) reflects real intended pricing before any client checks out live.
Has this been reviewed against current pricing intentions?
**Answer:**

---

## C. Infrastructure / operations

### C1. Error tracking — still fully unbuilt on master, not just missing a DSN
**Correction (2026-08-28):** the original text here said "the code side of Phase B2
is now built and merged" (`server/src/utils/errorTracking.js`, pino logging, Sentry
SDK wiring). That's true only of the unmerged `origin/gap-fixes-a-e` branch —
`master` has no `logger.js`, no `errorTracking.js`, no pino/Sentry dependency, and
every `console.*` call site across `pool.js`, `metaWebhook.js`, the four background
runners, etc. is unconverted. This needs real code work against current `master`
(not a blind merge of the branch's version — `master`'s versions of `metaWebhook.js`,
`broadcastRunner.js`, and others have all changed independently since), not just an
account/DSN. See `CLAUDE.md` Known Gaps for the full scoped writeup.
**Still also needed once the code exists:** someone to create a Sentry project (or
name a different provider — Bugsnag, Rollbar, Datadog) and hand over the DSN.
**Blocks:** nothing today (code doesn't exist yet); once built, blocks only the
integration actually reporting anything in production.
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
**Correction (2026-08-28):** the original text said "built already, using Supabase
Vault" (a pluggable `SECRET_STORE` env var in `encryption.js`, a
`supabaseVaultStore.js` backend, `server/scripts/rotate-secret-store.js`). That code
exists **only on the unmerged `origin/gap-fixes-a-e` branch** — `master`'s
`encryption.js` is still the single, non-pluggable `env`-backend implementation, and
`encrypt`/`decrypt` are still synchronous (the branch's version made them `async`
across ~11 call sites, which have all changed independently on `master` since —
reconciling that conversion needs fresh work, not a merge). Separately (and
confirmed real, not assumed): this local dev checkout's `SERVER_SECRET` cannot
decrypt any of the 4 real connected WABAs' stored tokens today — see `CLAUDE.md`'s
top Known Gaps entry for the full investigation. That's a distinct issue from this
question (a live secret-value mismatch, not a missing pluggable-backend feature) but
whoever answers this should be aware of both.
**What's needed if pursuing this**: (1) confirm Vault is enabled for the real
Supabase project, (2) decide Vault vs. KMS vs. staying on plain `SERVER_SECRET` (with
a properly synced value, see `CLAUDE.md`), (3) rebuild the pluggable-backend code
against current `master`, using the branch's version as a design reference, (4) a
real dry-run rotation before ever flipping this on for real traffic.
**Blocks:** nothing code-side today (feature doesn't exist on master). Separately,
the `SERVER_SECRET` mismatch above blocks any local session from decrypting a real
WABA token right now, regardless of which store is eventually chosen.
**Answer:**

### C6. Repo GitHub admin access — who sets branch protection?
Once a CI workflow exists and is green (see `CLAUDE.md` Known Gaps — a CI pipeline
was drafted on the unmerged branch but has NOT been adopted on `master`; it exposed
two real gaps of its own when validated against current code), someone with GitHub
repo admin rights needs to turn on "require status checks to pass before merge." Who
has that access on `github.com/Jesheeba/Wasi`?
**Answer:**

---

## D. Legal / compliance

### D1. Privacy Policy & Terms of Service — real counsel-reviewed text
`GO_LIVE_CHECKLIST.md` §1 flags that `/marketing/privacy.html` and
`/marketing/terms.html` currently have placeholder legal text and need real,
counsel-reviewed copy before Meta App Review submission (both URLs get linked in the
App Dashboard). **Re-confirmed still true (2026-08-28)**: both files still contain
placeholder text on `master` today. Who's engaging counsel for this, and by when?
**Blocks:** Meta App Review submission (A2 above).
**Answer:**

### D2. Data deletion / consent policy specifics
The opt-in/consent system auto-detects STOP-type messages including "best-effort,
not native-speaker-verified" Tamil/Tanglish variants. Is there a compliance/legal
review needed on the actual consent policy logic (what counts as opt-out, retention
of `consent_events`, etc.) beyond the current best-effort implementation?
**Answer:**

---

## E. Product scope decisions

These aren't blockers for anything already built, but two items have real
architectural forks that shouldn't be started on a guess:

### E1. Team inbox — full per-agent login, or attribution-only?
**Status correction (2026-08-28):** an attribution-only version (chat assignment
under the existing shared login, no per-agent auth) was built on the unmerged
`origin/gap-fixes-a-e` branch (`chats.assigned_to`, `PATCH /api/chats/:id/assign`,
an assignee filter/indicator in the chat UI) — but it was **never merged**, and
`master` has none of it: no `assigned_to` column, no assignment route, no assignee
UI. `CLAUDE.md`'s own feature inventory ("Shared Team Inbox: Not started") is
accurate for what's live on `master`, but a future session picking this up should
know a working attribution-only implementation already exists as a design
reference on that branch, not build blind — see `CLAUDE.md` Known Gaps. The
original question remains genuinely open: does each team member need their own
login (separate auth, larger effort) or is "who's this chat assigned to" enough?
What's actually being sold/promised to clients on this feature?
**Answer:**

### E2. Which larger integrations (if any) are actually wanted?
Ecommerce catalog, Meta's own WhatsApp Flows product, Instagram DM automation, CTWA
config — all currently static/decorative by deliberate scope decision on `master`
(confirmed still true 2026-08-28 — `CLAUDE.md`'s Known Gaps lists these same nav
items as confirmed dead). Is there a specific client asking for any of these, or
should they stay deferred?
**Answer:**
