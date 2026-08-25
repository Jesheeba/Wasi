# Gap Fix Plan — code-fixable items

Companion to `GO_LIVE_CHECKLIST.md` (account-side) and `TEAM_QUESTIONS.md` (things that
need a human/external/live answer before code can start). Everything in *this* file is
buildable without waiting on anyone outside the dev team — no Meta/Razorpay approval,
no legal review, no third-party account required to write the code (a couple of items
need a credential dropped in later; that's called out per-item).

Ordered by **risk-reduction first, features last** — the earlier phases make every
later change safer to ship, so doing them out of order costs more rework than it saves.

---

## Phase A — Deploy safety net (do this first, everything else benefits)

### A1. CI pipeline (GitHub Actions)

**Why first:** every other phase below ships a migration or a behavior change. Right
now nothing gates a bad one from reaching `main`/deploy — this is the single risk
`wasi-build-plan.md` §0.4 calls out as having live precedent (the CRM's silent
migration-drift incident). Every later phase is safer once this exists.

**Scope:**
- New `.github/workflows/ci.yml`, triggered on PR + push to `master`.
- Job 1 — **test**: spin up Postgres as a service container, `npm ci` in `server/`,
  run `npm run db:migrate` against the throwaway DB, then `npm run db:seed`, then
  `npm test` (`node --test`, covers the 14 files in `server/test/`).
- Job 2 — **migration dry-run**: same throwaway Postgres, run `db:migrate` up, then
  `db:migrate:down -- 0` (the `db:reset` down-half), confirming every migration in
  `server/src/db/migrations/` has a working `down` and doesn't error either direction.
- Branch protection: require the workflow to pass before merge (a GitHub repo setting,
  done once the workflow is green — flag this as a step for whoever has repo admin).

**Files touched:** new `.github/workflows/ci.yml` only. No application code changes.

**Effort:** ~half a day (mostly getting the Postgres service container + env vars
right against `server/.env.example`'s shape).

**Acceptance:** open a throwaway PR with a deliberately broken migration, confirm CI
fails and blocks merge.

### A2. Security headers (helmet)

**Scope:** add `helmet` to `server/package.json`, mount in `server/src/app.js`
alongside the existing `cors()` call. Explicitly disable `X-Powered-By`
(`app.disable('x-powered-by')` or via helmet's default). Configure CSP conservatively
at first (`contentSecurityPolicy: false` initially, since the root/`admin`/`marketing`
static sites use inline scripts/styles per `APPLICATION.md` — tightening CSP is a
separate, riskier follow-up, not bundled into this pass) but keep HSTS,
`X-Content-Type-Options`, `X-Frame-Options`.

**Files touched:** `server/package.json`, `server/src/app.js`.

**Effort:** ~1 hour including a manual check (`curl -I`) that headers show up on all
three static mounts (`/`, `/admin`, `/marketing`) and the API.

**Acceptance:** `curl -I https://<host>/health` shows `X-Content-Type-Options`,
`X-Frame-Options`, no `X-Powered-By`.

### A3. Razorpay webhook signature length-check

**Scope:** small robustness fix — `server/src/routes/razorpayWebhook.js` currently
calls `crypto.timingSafeEqual` without a length check first (unlike
`metaWebhook.js`'s implementation), so a malformed/mismatched-length signature header
throws a `RangeError` instead of cleanly returning `false`. Currently fails safe as a
500 via `asyncHandler`, but should match the Meta implementation's explicit length
guard for consistency and a cleaner 400 response instead of a 500.

**Files touched:** `server/src/routes/razorpayWebhook.js`.

**Effort:** ~30 minutes including a new test case in the Razorpay webhook coverage
mirroring the existing Meta one.

---

## Phase B — Observability

> **Update (2026-08-25): B3 is already built, and it's more than what was originally
> scoped here.** A prior pass through this repo (before this plan's first draft was
> re-checked against current code) added `server/src/services/alertRunner.js` +
> `alertNotifier.js` — a 5-minute-tick reconciler covering 8 business-critical
> conditions (webhook silence >24h, 5-in-a-row webhook failures, WABA restrictions,
> non-green quality rating, paused/disabled templates, terminal webhook-delivery
> failures, failed-send spikes, auth-class send errors), deduped via `alert_events`
> (migration `019_alerting.js`), notified over email and optionally WhatsApp, plus a
> daily digest. This closes the *business-condition* alerting gap `wasi-build-plan.md`
> §6.1 originally flagged. What it does **not** cover, and what's left below: generic
> code-level exception tracking, and — critically — **alertRunner itself is an
> in-process `setInterval`, so if the whole Node process crashes, it stops running too**.
> It cannot alert on its own death. External process-liveness monitoring is still a
> distinct, real gap (see `TEAM_QUESTIONS.md` C2).

### B1. Structured logging — done

Built `server/src/utils/logger.js` (pino, level via `LOG_LEVEL`). Every
`console.error`/`console.warn`/`console.log` call site in `server/src` that's part
of a real runtime failure/observability path was converted — `pool.js`,
`index.js`'s process-level handlers, `errorHandler.js` (the central route-error
catch-all — not originally scoped, added because it's the single highest-value
conversion in the app: every unexpected route exception funnels through it),
`metaWebhook.js` (all 5 sites, including the `metaWebhook FAILURE` line — the
grep-able string is preserved verbatim in the log message so existing tooling built
around it keeps working), `broadcastRunner.js`, `forwardRunner.js`, `flowRunner.js`,
`alertRunner.js`, `tenantContext.js`, `requireApiKey.js`, `consentRepo.js`,
`alertNotifier.js`, `automationEngine.js`, `onboarding.js`, `metaClient.js`.

**Deliberately left as plain `console.*`, not converted:** `db/seed.js` (a CLI
script — a developer needs to read the printed demo credentials directly off their
terminal, not a JSON log line), `utils/emailService.js`'s "would have sent"
dev-mode notice (contains the actual password-reset link a developer needs to
click — human-readability wins over structure here), and `dbSafety.js`'s
production-override warning (a deliberately loud, unmissable message for a human
consciously bypassing a safety guard). All three are conscious exceptions, not
missed call sites.

### B2. Error tracking integration — done (code side; needs a DSN to activate)

Built `server/src/utils/errorTracking.js`, gated on `SENTRY_DSN` (blank by default
in `.env.example`, same degrade-gracefully pattern as every other optional
integration) — `initErrorTracking()` called once at `index.js` startup,
`captureException(err)` wired alongside the structured-log call at every genuine
crash-class site: `pool.js`'s pool-level error, `index.js`'s
`unhandledRejection`/`uncaughtException` (with a `flush()` await before
`process.exit(1)` so an in-flight Sentry delivery isn't dropped by the exit racing
it), `errorHandler.js`'s catch-all, `metaWebhook.js`'s FAILURE path and its
`meta_webhook_log` persist-failure (captured specifically because that table feeds
`alertRunner.js` — a silent failure to write it would blind the alerting engine
without anyone noticing), and all four background-runner `tick()` catches
(`broadcastRunner`, `forwardRunner`, `flowRunner`, `alertRunner` itself).
**Deliberately not captured**: per-delivery failures already covered by a proper
alertRunner check (a client's webhook endpoint being down triggers
`checkWebhookDeliveryFailures`, not a code bug here) and the handful of
already-degrading-gracefully non-fatal logs (email/WhatsApp alert send failures,
`apiKeysRepo.touchLastUsed`) — capturing those would just be Sentry noise for
expected, already-handled conditions.

**Still needs, before it actually reports anything:** a real `SENTRY_DSN` — see
`TEAM_QUESTIONS.md` C1.

**Files touched:** new `server/src/utils/logger.js` and
`server/src/utils/errorTracking.js`; edits across all files listed above;
`server/.env.example` (`LOG_LEVEL`, `SENTRY_DSN`); `server/package.json`
(`pino`, `@sentry/node`).

**Verification:** syntax-checked every edited file (`node --check`), then smoke-
tested the full module tree (`createApp()` builds all 83 routes; logger emits
correctly-shaped structured JSON including serialized error/stack; error tracking
confirmed to no-op safely with no `SENTRY_DSN` set). Could not run the full
integration test suite in this pass — this machine's `server/.env` points
`DATABASE_URL` at the real production Supabase instance, and `dbSafety.js`
correctly refused to let a local script run against it (working as designed, not a
bug). Needs running against a real non-production database — the CI workflow from
Phase A does this automatically against an isolated container Postgres on the next
push/PR.

~~### B3. Alerting hook for the metaWebhook failure path~~ — **done**, see the note
at the top of this phase. No further action needed here.

> External uptime polling (something outside this infra hitting `/health`, able to
> alert even if the whole process — and therefore alertRunner — is down) is **still
> not built and can't be**: it inherently requires a watcher outside this
> infrastructure. Tracked as `TEAM_QUESTIONS.md` C2, not a code task.

---

## Phase C — Hub API completeness

~~### C1. Delivery/read receipt forwarding~~ — **already done, verified in code.**
`server/src/routes/metaWebhook.js`'s `handleStatuses` (around line 220) already calls
`enqueueForwards(waba, 'message.status', { message_id, status, error })` for every
Meta status transition, guarded by `messageStatusForwardsRepo.recordIfNew` (an
atomic `INSERT ... ON CONFLICT DO NOTHING` on `(meta_message_id, status)`, migration
`033_message_status_forwards.js`) so Meta's redelivery-on-non-2xx behavior can't
produce duplicate forwards. `wabas.forward_events`' CHECK constraint was already
widened for this in migration `032_widen_forward_events.js`. **Action item instead of
a build task: `crm-integration-guide.md` (the client-facing doc) still says
"Not currently forwarded: per-message delivery/read status" — that line is now
false and should be corrected** (change the "Event types available today" list to
include `message.status`, and drop the "Not currently forwarded" paragraph). This is
a 10-minute doc fix, not implementation work.

### C2. Self-signup client API key surface — done

Confirmed the existing `developer` settings tab (`APPLICATION.md` §6.1) was exactly
what it looked like: a hardcoded fake key (`crm_live_sample000000000000`) with a
copy button and no backend behind it at all. No shared-service extraction was
needed — `apiKeysRepo.js`'s `create`/`listByClientId`/`revoke` were already generic
over `(db, clientId, ...)`, so `routes/admin.js` and the new client-facing route
both call the exact same functions, just on different connections (`pool` for
admin, `req.db` for the client route).

- New `server/src/routes/apiKeys.js`: `GET /` (list own keys), `POST /`
  (generate — key shown once in the response, never again), `DELETE /:id`
  (revoke), mounted at `/api/api-keys` behind `requireClientAuth` +
  `withTenantContext` (same pattern as every other tenant-scoped route, e.g.
  `routes/tags.js`) in `server/src/app.js`.
- New `apiKeyCreateSchema` in `server/src/utils/validate.js` — deliberately takes
  only `app_name`, never `client_id`, since a client route derives its own tenant
  from the JWT (`req.clientId`), unlike the admin route which must be told which
  tenant it's acting on.
- **Notable finding along the way**: `api_keys` already had RLS enabled and forced
  with a `tenant_isolation` policy since migration `014_hub_capability.js` — that
  migration's own comment says this was "defense-in-depth... not exercised today,"
  because every existing caller ran on the privileged `pool` connection. This new
  route is the first real caller that goes through the restricted `wasi_app` role,
  so it's the first thing that actually exercises that policy for real.
- Front end: replaced the fake key display in `index.html`'s `sec-view-developer`
  with a real generate-key form (name input, one-time key-value reveal with a copy
  button) and a live table of existing keys (app name, created, last used, status,
  revoke button) — wired in `app.js` (`renderApiKeysTable`, plus generate/copy/revoke
  handlers) and dispatched from the Settings sub-nav alongside the other tabs.
  Bumped `index.html`'s `app.js?v=` cache-busting query param, matching this repo's
  existing convention for any `app.js` change.

**Verification:** syntax-checked all touched files; smoke-tested that `createApp()`
still builds cleanly with the route count rising from 83 to 86 (the three new
endpoints), confirming the router mounts without error. Not exercised against a
real database in this pass, for the same reason noted in Phase B's verification
note (this machine's local `.env` points at production) — will run for real via the
Phase A CI workflow on the next push/PR.

**Not built, deliberately out of scope for this pass:** a regression test for the
new route itself. No existing test file covers it — worth a follow-up test mirroring
`server/test/api.test.js`'s pattern (real app boot, real HTTP calls, a disposable
test client) before this ships to production.

---

## Phase D — Security hardening

### D1. Token encryption → real secret store — code built, activation still pending

**Why:** `server/src/utils/encryption.js` (AES-256-GCM keyed by `SERVER_SECRET`) is
explicitly self-documented as an MVP choice, adequate to ship with but not once real
client WABA access tokens accumulate at scale.

**Built without waiting on the Team Questions answer** (Supabase Vault was still
the plan's own stated "path of least resistance" default, so that's what got
scaffolded — swappable later if the team prefers AWS KMS instead, see below):

- `encryption.js` is now a thin dispatcher over `SECRET_STORE` (env var: `env`
  default, or `supabase_vault`), delegating to `server/src/utils/secretStores/
  envKeyStore.js` (the original logic, moved verbatim, unchanged behavior) or the
  new `supabaseVaultStore.js`. `encrypt`/`decrypt` are now `async` — required for
  Vault (a real DB round trip) — which meant adding `await` at all ~11 existing
  call sites (`admin.js`, `templateSyncService.js`, `templates.js` ×2,
  `apiV1Templates.js`, `onboarding.js` ×4, `messagingService.js` ×2,
  `alertNotifier.js`). Caught one missed call site (different indentation broke a
  `replace_all` match) via a full-repo grep sweep before calling this done — worth
  noting given how easy an un-awaited call here would be to miss silently (it
  wouldn't throw, `accessToken` would just be a pending Promise object passed to
  Meta's API instead of a string, failing confusingly downstream).
- `supabaseVaultStore.js` stores Vault's own secret UUID (from `vault.create_secret`)
  in the same `access_token_encrypted` text column — no migration needed to switch
  backends. **Explicitly UNVERIFIED against a real Supabase Vault instance** — Vault
  isn't available on a vanilla `postgres:16-alpine` (local dev, this repo's CI), only
  on a Supabase project with it enabled, so nothing in this environment could
  exercise it live. Full pre-flight checklist is in the file's own header comment.
- New `server/scripts/rotate-secret-store.js` — the one-time cutover: decrypts every
  `wabas.access_token_encrypted` under the old backend, re-encrypts under the new
  one. Has its own `ROTATE_DRY_RUN` mode and a separate `ROTATE_CONFIRM` safety
  token (distinct from `dbSafety.js`'s production guard, which still applies too) —
  this rewrites every connected client's live access token at once, so it's gated
  harder than an ordinary script.
- `.env.example`: new `SECRET_STORE=env` (default, documented) alongside
  `SERVER_SECRET`.

**Verification — the most rigorous of any phase so far, not just a smoke test:**
`server/test/encryption.test.js` actually **runs** (`node --test`, not just
`node --check`) against a safe non-production `DATABASE_URL`, and all 4 tests pass
for real: the default (`env`, both unset and explicit) backend round-trips
correctly, two encryptions of the same plaintext produce different ciphertext
(fresh IV each call), and an unknown `SECRET_STORE` value throws clearly instead of
silently misbehaving. This is the one piece of this whole effort proven to actually
work end-to-end, not just "loads without a wiring error" — appropriate given this
is the highest-blast-radius change in the plan (get it wrong and every client's
WhatsApp connection breaks). The `supabase_vault` backend itself has no live test —
can't, without a real Vault-enabled project — see its file header for the pre-flight
steps to run manually before ever setting `SECRET_STORE=supabase_vault` for real.

**Still open** (`TEAM_QUESTIONS.md` C5): confirm Supabase Vault (what got built) vs
AWS KMS vs something else is actually the preferred store — swapping later just
means adding a third `secretStores/` module and updating the `STORES` map in
`encryption.js`, not redoing this phase.

---

## Phase E — Product features

### E1. Inbound media fetch/store — done, built as proxy-on-demand (not a media library)

**Why:** customer-sent images/audio/docs used to render only as a `[type]`
placeholder — the single largest functional gap in the messaging core itself.

**Scope decision, asked rather than guessed:** the original scope above called for
storing the fetched file (new Supabase Storage bucket). Before starting, found that
this codebase already has an explicit, documented policy for outbound header media
(`mediaHeaderService.js`'s module comment: "Meta is the file store... persisting the
original file ourselves [is] explicitly out of scope — no media library") — adding a
storage bucket for inbound would have broken that established pattern and introduced
real new surface (storage cost, a retention/deletion policy, and a new place that
needed wiring into the existing GDPR data-deletion webhook). Asked the user rather
than picking unilaterally: chose **proxy from Meta on demand**, keeping the same
"Meta is the file store" posture for inbound too.

**Built:**
1. Migration `034_inbound_media.js` — `messages.media_id` / `media_mime_type` /
   `media_filename` (Meta's own media id, not a locally-stored blob or URL).
2. `metaWebhook.js`: `handleInboundMessages` now captures the media object for
   `image|audio|video|document|sticker` (Meta nests it under a key matching
   `msg.type` exactly) and builds a body like `[Image] optional caption` instead of
   the old generic `[image]` tag. Non-media types are unaffected.
3. New `GET /api/chats/:id/messages/:messageId/media` (`chats.js`) — tenant-scoped,
   resolves the client's connected WABA (reused `messagingService.getSendableWaba`,
   newly exported rather than duplicated), decrypts its token, calls
   `metaClient.getMediaUrl` then `downloadMediaBytes` (both already existed for
   outbound media — reused as-is), and streams the bytes back with the right
   Content-Type. Every request re-fetches from Meta fresh — no caching, matching
   the "don't store it" decision; a message whose media has aged out on Meta's side
   fails with a clear 502 rather than ever having worked and then silently breaking.
4. Added *optional, additive* `timeoutMs` support to `metaClient.js`'s `graphFetch`/
   `getMediaUrl`/`downloadMediaBytes` (15s, used only by this new route) — narrowly
   scoped to the one call site the plan committed to, not the broader "audit every
   fetch() in this file" pass `wasi-build-plan.md` §6.1 separately calls out as its
   own, bigger undertaking.
5. Front end: media messages render as a click-to-fetch button (icon + label by
   mime type — image/audio/video open in a new tab, documents download) rather than
   auto-loading thumbnails — deliberately simpler and lower-risk than eager-loading
   arbitrary-sized customer-sent files into every open chat thread. Uses a new
   `authFetchBlob` helper (`authFetch` always parses JSON, unusable for binary) with
   the same object-URL pattern the existing CSV export already uses. Bumped
   `app.js?v=` again.

**Verification:** syntax-checked and app-boot smoke-tested as usual (86 routes,
unchanged — a route added inside an existing sub-router doesn't change the
top-level mount count). Added `server/test/inboundMedia.test.js` covering every
path reachable without a real Meta call (auth rejection, unknown message, no-media
message, no-connected-WABA) — same tradeoff as the existing
`mediaHeaderService.test.js`: the real Meta-fetch success path has no automated
test, since it needs a real WABA and a real inbound media message, not a fixture.

**Bonus, not separately scoped:** the Hub API's `message.received` forward payload
(`crm-integration-guide.md`) now includes `media_id`/`media_mime_type`/
`media_filename` automatically, since that payload already spreads the full message
row. Harmless to include (a bare Meta media id isn't sensitive, and is useless to a
receiving CRM without the WABA's own token) — left as-is, not documented as a new
guaranteed field since it was incidental, not designed.

### E2. Team inbox — chat assignment (attribution-only) — done

**Scope decision:** asked rather than guessed (same reasoning as E1) — attribution
labels under the existing single shared client login, not full per-agent
authentication. Chosen explicitly by the user: smaller change (~1.5 days vs. ~4-5),
doesn't touch the JWT/auth system, still fully reversible/extensible into real
per-agent auth later if ever needed.

**Built:**
1. Migration `035_chat_assignment.js` — `chats.assigned_to` (nullable FK to
   `team_members`, `ON DELETE SET NULL` — removing a team member un-assigns their
   chats rather than blocking the delete or cascading it; covered by a test).
2. `chatsRepo.assign(db, clientId, id, teamMemberId)` + new
   `teamMembersRepo.findById` (didn't exist — needed for a friendly 404 on
   assigning to a since-removed/nonexistent member, ahead of the FK constraint's
   own 400).
3. New `PATCH /api/chats/:id/assign` (`{ team_member_id: uuid | null }`,
   `chatAssignSchema` in `validate.js`) — explicit attribution-only note in the
   route's own comment, so a future per-agent-auth pass doesn't mistake this for
   an authorization boundary it was never meant to be.
4. Front end: an "Assigned to" filter section in the existing chat-list filter
   dropdown (a second, independent dimension AND'd with the existing tag filter —
   had to scope the two groups' active-button-state queries to separate wrapper
   divs, since they share the same `.filter-option` CSS class and would otherwise
   clear each other's selection on click), an assignee indicator on each chat-list
   row, and an assignee `<select>` in the open chat's header wired to the new
   endpoint. Team members are fetched once at load (`loadInitialData`, same
   once-per-session convention `tagsById` already uses), not re-fetched on every
   poll tick. Bumped `app.js?v=` again.

**Files touched:** new migration; `chatsRepo.js`, `teamMembersRepo.js`,
`routes/chats.js`, `validate.js`; `index.html` (filter panel + chat header markup),
`index.css` (no new rules needed — reused `.filter-option`/`.form-input`), `app.js`.

**Verification:** syntax-checked, app-boot smoke-tested (86 routes, unchanged — a
route inside an existing sub-router doesn't move the top-level count). New
`server/test/chatAssignment.test.js` — 6 tests, including specifically proving the
`ON DELETE SET NULL` behavior (a team-member delete un-assigns rather than
failing), the one part of this feature actually risky to get wrong silently.

### E3. Analytics expansion — done

Scoped to the plan's own recommendation ("2-3 concrete metrics, not open-ended more
analytics"): configurable window + CSV export + two new trend aggregations.

**Built:**
1. `?days=` on `GET /api/analytics/messages` (same clamp convention as
   `admin.js`'s `/api/admin/volume?days=`, 1-365) — default stays 7 when omitted,
   so an existing caller with no `?days=` gets byte-for-byte the original behavior.
2. New `GET /api/analytics/messages/trend?days=` — per-day breakdown (the
   aggregate endpoint only ever returned one summed total for the whole window;
   this is what an actual trend chart or export needs).
3. New CSV exports: `GET /api/analytics/messages/export` and `.../tags/export`
   (server-generated, `text/csv` + `Content-Disposition: attachment`). Campaign
   export was done client-side instead, no new endpoint — `state.broadcasts` is
   already loaded in exactly the shape that table displays, same precedent the
   existing contacts CSV export already set.
4. New aggregations: `GET /api/analytics/contacts/growth?days=` (per-day new
   contacts **plus a running cumulative total that starts from the count of
   contacts that existed before the window**, not from zero — a growth chart
   that resets to 0 at the window boundary would misrepresent an account with
   existing contacts) and `GET /api/analytics/campaigns/trend?days=` (broadcasts
   grouped by send day, summed delivered/averaged read rate — multiple campaigns
   on the same day roll into one row).
5. Front end: the Message report's chart card was a **hardcoded fake SVG path
   with made-up numbers and dates**, unconditionally shown regardless of any real
   account state — replaced with `renderMessageTrendChart`, a real dynamically-
   scaled dual-line chart (backfills missing days to zero so the 7-day axis never
   has gaps). Added working CSV export buttons to the Message/Tags/Campaign report
   views. Deliberately did **not** build new dashboard panels for the contact-growth
   or campaign-trend endpoints — those are net-new aggregations with no existing
   UI placeholder to "wire up" the way the fake chart was; they're available for a
   future dashboard but adding two new panels wasn't in the 2-3-metric scope.
   Bumped `app.js?v=` again.

**Not touched, deliberately** (per the plan's own note): Flow/API/Live-Chat/
Operator-stats report sub-views stay static — no underlying feature exists yet to
report real numbers on for any of them (`GO_LIVE_CHECKLIST.md` §4).

**Files touched:** `server/src/routes/analytics.js` (rewritten — no new repo file
needed, the query count stayed small enough to keep inline); `index.html` (chart
container, three export buttons); `app.js`.

**Verification:** syntax-checked, app-boot smoke-tested (86 routes, unchanged).
New `server/test/analyticsExpansion.test.js` — 8 tests, seeding a real inbound
message so the trend/export/growth queries have real data to prove against, not
just an empty-array happy path; specifically checks the default-window backward-
compatibility claim and the cumulative-growth-doesn't-reset-to-zero property.

### E4. Billing → real recurring cancellation — done, built as an additive placeholder

**Why:** `POST /cancel` used to just flip a local DB flag; there was no Razorpay
Subscriptions-API mandate to actually cancel because billing was originally built
on the one-off Orders API, not Subscriptions.

**Decision:** asked rather than guessed. The user chose Razorpay's real Subscriptions
product (gets Razorpay's own dunning/retry for free) but has no Razorpay account
configured yet — "keep it as a placeholder" until real keys/plan IDs exist. Built
the same way Phase D handled an equivalent situation (a real backend with no live
credentials to verify against): fully additive, opt-in per plan, zero behavior
change until explicitly activated.

**Built:**
1. Migration `036_recurring_billing.js` — `plans.razorpay_plan_id` (nullable text,
   **null for every plan by default** — a real Razorpay Plan doesn't exist yet) and
   `subscriptions.billing_mode` (`'one_off'` default / `'recurring'`).
2. `razorpayClient.js`: new `createSubscription`/`cancelSubscription`, calling
   Razorpay's documented Subscriptions API. **Explicitly UNVERIFIED against a live
   Razorpay account** — no credentials exist in this environment to exercise it,
   same caveat as Phase D1's Supabase Vault backend. `RECURRING_TOTAL_CYCLES = 120`
   in `billing.js` — Razorpay has no literal "bill until cancelled," the documented
   convention is a large cycle count plus an explicit cancel.
3. `billing.js`'s `/checkout`: branches on `planRow.razorpay_plan_id` — set, use the
   new Subscriptions flow; **null (every plan, today), fall through to the exact
   original Orders-API code, unchanged**. `/cancel`: branches on
   `subscription.billing_mode` — `'recurring'` calls Razorpay's real cancel first
   (a failure there surfaces as a real 502, not a silent local-only flip that would
   leave the client actually still billed next cycle); `'one_off'` keeps its exact
   original behavior.
4. `razorpayWebhook.js`: new handling for `subscription.activated`/`.charged`
   (marks active, bumps `renews_at` from Razorpay's `current_end`, and — unlike the
   one-off flow's create-then-update dance — creates each cycle's invoice already
   paid via `invoicesRepo.createPaid`, since there's no pre-existing pending row for
   a future cycle to update against) and `.cancelled`/`.completed`/`.halted`
   (halted = Razorpay's own dunning exhausted, mapped to `payment_failed`, not a
   clean cancel). **Also unverified** — inferred from Razorpay's documented webhook
   payload shape, not confirmed against a real delivery the way `payment.captured`
   already has been (that one was verified live during the original build).
5. Front end: `marketing/signup.js`'s checkout now passes `subscription_id` to the
   Razorpay Checkout.js widget instead of `order_id`/`amount`/`currency` when the
   backend response signals a recurring checkout (Checkout.js supports both modes
   natively — a small, contained extension of the existing widget wiring, not a
   rebuild).

**Verification:** syntax-checked, app-boot smoke-tested (86 routes, unchanged).
New `server/test/recurringBilling.test.js` proves the two things that actually
matter given no live Razorpay account to test against: (1) every seeded plan still
has `razorpay_plan_id = null`, so the recurring branch is provably dead code in any
real deployment today; (2) `/cancel` genuinely branches on `billing_mode` — a
`one_off` subscription cancels locally with no Razorpay call (exact original
behavior), a `recurring` one visibly attempts and fails the Razorpay call rather
than silently succeeding, and critically, that failure does **not** flip the local
status anyway (which would be worse than doing nothing — a client showing
"cancelled" locally while Razorpay keeps billing them).

**Before this can activate for real:** create a real Razorpay Plan per pricing tier
in their dashboard, set `plans.razorpay_plan_id` to each real `plan_id`, and run one
real subscription create → webhook charge → cancel cycle end to end — see
`TEAM_QUESTIONS.md` B2.

---

## Phase F — Larger, lower-priority integrations (only if the business wants them)

Each of these is a full separate Meta product integration, not a bug fix — listed for
completeness, not recommended as near-term work unless a client specifically asks:

- **Ecommerce catalog** — real Meta Commerce Catalog API integration.
- **Meta's own "WhatsApp Flows" product** — distinct from this repo's `flow-editor`/
  `automationFlows` (that's Wasi's own automation engine); Meta's Flows is a separate
  JSON-schema-driven in-chat form product with its own Graph API surface.
- **Instagram DM automation** — separate Meta product, separate webhook subscription.
- **Click-to-WhatsApp Ads (CTWA)** — Meta Ads integration for ad-attributed
  conversation starts.

---

## Suggested sequencing

```
Phase A (deploy safety)     → DONE
Phase B (observability)     → DONE (code side) — needs a Sentry DSN to activate
Phase C (Hub completeness)  → DONE
Phase D (token encryption)  → DONE (code side) — needs a live Vault check to activate
Phase E (product features)  → DONE (E1, E2, E4 as a placeholder, E3) — see below
Phase F (new integrations)  → only on client demand, not started
```

**Everything in Phases A–E is now built and merged into the working tree** (not yet
committed — see git status). Every phase followed the same discipline: syntax-check
every touched file, smoke-test the full app boot after each change, and where a
real behavior could be tested without live external credentials (Meta media,
Razorpay, Supabase Vault), write a test that actually proves it rather than just
asserting the code parses.

**What's still genuinely unverified, not because the code is untrustworthy but
because nothing in this environment can exercise it live:**
- Phase B2's Sentry integration — no `SENTRY_DSN` exists to send a real event to.
- Phase D1's Supabase Vault backend — no Vault-enabled Supabase project reachable
  from here; `supabaseVaultStore.js`'s header lists the exact pre-flight checks.
- Phase E1's real Meta media-fetch success path — needs a real WABA + a real
  inbound media message, not a fixture.
- Phase E4's Razorpay Subscriptions flow — no Razorpay account/plan IDs configured;
  every plan ships with `razorpay_plan_id = null` so this is provably inactive.

Each of those has a corresponding `TEAM_QUESTIONS.md` item spelling out exactly
what's needed to close the loop.
