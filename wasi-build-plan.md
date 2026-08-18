# Wasi — Build Plan

**What Wasi is:** the official WhatsApp Business API platform. It holds the Meta credentials, owns the single webhook, and every other Sirah application consumes it.

**Meta side is complete.** App `27135450269410430`, Tech Provider verified, both WhatsApp permissions at Advanced access, app published. No reviews pending, nothing waiting on Meta. Everything below is code.

**Current state per audit:** ~60–65% of a shippable v1 *at the time of the original audit*. Phases 1–4 below are now done (Phase 2 except one step blocked on Meta's side, not this codebase) — this line is left as the historical baseline, not updated to a new percentage, since the remaining phases (5–8) haven't been re-scoped against what actually shipped. The hard parts are genuinely built — HMAC signature verification with `timingSafeEqual`, AES-256-GCM token storage, the 24-hour window rule enforced in the send path, idempotent inbound inserts, a real broadcast worker using `FOR UPDATE SKIP LOCKED`, plan limits wired into the send path, database-level tenant isolation via RLS, opt-in/consent tracking. Database fully migrated, 13 migrations, 26 tables.

---

## PHASE 0 — Do this before writing any code

### 0.1 Version control — DONE (2026-08-17)

The audit found **no git repository at any depth** — ten days of work existed on one machine with no history, no rollback, no backup. That gap is now closed:

- [x] `.gitignore` confirmed correct before staging — `server/.env` (live `DATABASE_URL`), both `node_modules/`, `server/.pgdata/`, and `serve.log` all excluded; `server/.env.example` and `render.yaml` (no live secret values, uses `sync: false`) confirmed safe to commit
- [x] `git init`, `git add .`, `git commit -m "initial commit: Wasi platform"`
- [x] Remote created manually on github.com and pushed — `gh` CLI was **not installed** on this machine (confirmed in both Bash and PowerShell), so the `gh repo create --push` one-liner below didn't run as written; used `git remote add origin` + `git push -u origin master` instead
- [x] Pushed to **`https://github.com/Jesheeba/Wasi.git`** (repo named `Wasi`, not `sirah-wasi` — chosen when creating it manually on github.com), private. Verified live via `git ls-remote origin`: local and remote both at commit `3b0143e`.

```bash
# What actually ran, for reference:
git init
git add .
git commit -m "initial commit: Wasi platform"
git remote add origin https://github.com/Jesheeba/Wasi.git
git push -u origin master
```

**Residual risk, not fully closed:** this is one squashed "initial commit" covering the entire ~10-day build — there's no incremental history of *how* it evolved, only a snapshot of where it ended up. The rollback/backup risk that motivated this phase is real now (a hard reset or lost machine no longer loses everything), but the discipline that actually closes this gap is committing as you go from here forward, not the one-time init. If another week of work piles up before the next commit, the practical risk returns even though `.git/` technically exists.

> This was the single highest-risk item in the whole plan. It's done — everything else is recoverable, and now so is this.

### 0.2 Meta credentials

`server/.env` — currently blank on purpose:

```
META_APP_ID=27135450269410430
META_APP_SECRET=<App settings → Basic → App Secret>
META_CONFIG_ID=2233975294116607
META_VERIFY_TOKEN=<pick a long random string>
```

- [ ] Leave Razorpay blank for now — billing isn't on the path to a working message

### 0.3 Webhook decision

Meta allows **one default webhook URL per app**. It currently points at Sirah CRM. Pointing it at Wasi means the CRM stops receiving inbound messages.

- [ ] **Chosen approach:** keep the default on the CRM. Test Wasi using a webhook override on a test WABA. Swap the default to Wasi only once Wasi has verifiably sent and received a real message.

### 0.4 Deploy / migration coupling — same failure shape as the CRM incident, not yet proven safe

This is the same category of risk that hit the CRM (see "Unrelated but still outstanding" at the bottom), and it applies to Wasi's own deploy pipeline directly, not just by analogy.

**What's already in place:** `render.yaml`'s `preDeployCommand: npm run db:migrate` does tie schema migration to deploy — Render runs it before starting the new instance, and (per Render's documented behavior) a non-zero exit aborts the deploy and keeps the previous version running. `node-pg-migrate` also wraps each migration file in its own transaction by default, so a failure partway through one file rolls that file back rather than leaving it half-applied. This is a real mitigation, better than two fully independent manual steps.

**What's not in place, and is the actual gap:**
- No CI. Migrations and the test suite (`server/test/api.test.js`) run on a developer's machine, if at all, before merge — nothing gates a bad migration from reaching `main`/the deploy branch.
- No staging environment. The very first time any given migration runs against anything resembling production data is when it runs against actual production, via `preDeployCommand`, during a real deploy.
- No pre-migration backup step. If a migration *does* succeed but does the wrong thing (drops/alters something it shouldn't), there's no automatic snapshot to restore from — only whatever Supabase's own backup retention provides.
- The safety net above (transactional rollback, non-zero exit aborting deploy) has never actually been tested against a real failure. It's inferred from tool defaults and Render's docs, not verified against an induced failure in this project.

**Why this matters concretely:** the CRM's fourteen-migrations-silently-drifted incident — one of which permanently destroyed every inbound WhatsApp message for weeks — happened because migration application and code deploy were independent manual steps with no automated gate between them. Wasi's `preDeployCommand` wiring is a step better than that, but "a step better than fully manual" is not the same as "verified safe." Treat this as a known production failure mode with precedent in this exact codebase family, not a nice-to-have CI item.

- [ ] Add a CI workflow (GitHub Actions) that runs `npm test` and a migration dry-run against a disposable Postgres on every PR — deploy only fires on green, mirroring the fix already proposed for the CRM in the closing section below
- [ ] Confirm Supabase point-in-time recovery / backups are actually enabled for the Wasi project before onboarding any real client, not just assumed
- [ ] Before the first production migration after a client is live, take a manual snapshot first — don't rely on the untested safety net alone

---

## PHASE 1 — Named parameters (2 hrs) — DONE (commit `292dbf3`)

Wasi's template system handled numbered parameters (`{{1}}`, `{{2}}`) only. **Meta now rejects these** — confirmed by live rejection in WhatsApp Manager. Templates would have failed on first real use.

- [x] Validator built as `server/src/utils/templateParams.js` (reimplemented for this codebase, not a literal port of Sirah CRM's TS file)
- [x] Parser extracts named params: `/\{\{\s*([a-z0-9_]+)\s*\}\}/g`
- [x] Rejects purely numeric parameter names
- [x] Rejects mixed numbered/named usage in one template
- [x] Kept the variable-at-start/end check
- [x] Create payload sends `parameter_format: "named"` (lowercase)
- [x] Body example shape: `example.body_text_named_params: [{ param_name, example }]`
- [x] Send path passes `{ type: "text", parameter_name, text }` objects, not a positional array
- [x] Seed data updated to named parameters
- [x] Beyond original scope: a params-words-ratio rule (`words >= 3*params + 2`), reverse-engineered after a real template got live-rejected by Meta (error 2388293) for too few words per parameter — no official Meta threshold is documented; this is corroborated against third-party BSP docs, not Meta's own spec, and should be revisited if Meta ever publishes the real rule

> Header and button named-parameter shapes are still not documented by Meta and still untested — this phase only covers the body.

---

## PHASE 2 — First real message (half a day) — DONE except step 6, blocked on Meta config, not code

Verified live against the real Meta App (`27135450269410430`) and a real WABA (`983390651411856`), through a short-lived ngrok webhook override — added, used, and removed again for each verification window, per the plan.

- [x] Added a WABA record with a real `phone_number_id`, `waba_id`, and system user token (pasted directly for this verification pass, not obtained through Embedded Signup — see new §6.2: Embedded Signup itself has still never been run end-to-end)
- [x] Set a webhook override on that WABA pointing at Wasi's `/webhooks/meta`
- [x] Verified Meta's GET handshake succeeds
- [x] Sent one text message via `metaClient.js` → confirmed delivery on a real phone
- [x] Replied from the phone → confirmed the inbound row lands in `messages`
- [x] Created a template through Wasi → confirmed it appears in WhatsApp Manager as Pending
- [ ] **Step 6 — blocked, not failed.** Webhook fields (including `message_template_status_update`) were subscribed in the Meta App Dashboard as instructed, the override was confirmed active, and a new template was approved during the verification window — but the ngrok request log (ground truth, not inference) showed **zero** `message_template_status_update` POSTs arriving across the whole session. That points at a Meta App Dashboard configuration issue outside this codebase's control, not a bug here — the dispatch logic for this exact field is implemented and covered by a regression test using a real captured payload shape (`server/test/metaWebhookDispatch.test.js`), it's just never been exercised by an actual Meta delivery. Needs re-attempting from the Meta side (re-check field subscription, re-subscribe, or open a Meta support case) before this can be marked done.
- [x] Sent that template with named parameters → confirmed values resolve, not literal `{{customer_name}}`

Real bugs found here, not hypothetical ones — see §6.1: a `pg.Pool` idle-connection crash (fixed, later validated against a real subsequent outage) and a webhook handler that swallowed per-change failures and always returned 200 regardless (fixed — this is the same failure shape that permanently destroyed inbound messages on Sirah CRM).

---

## PHASE 3 — Tenant isolation via RLS (1 day) — DONE (commit `61b8685`)

Isolation was app-layer `WHERE client_id = $1` only. One query written without that clause would have leaked another client's conversations, with nothing to catch it.

- [x] Enabled + **forced** RLS on 20 tables total: the original 11 (`wabas`, `contacts`, `chats`, `messages`, `broadcasts`, `broadcast_recipients`, `message_templates`, `subscriptions`, `invoices`, `team_members`, `contact_attributes`) plus 9 more added to the schema since this plan was written (`usage_logs`, `tags`, `automation_rules`, `support_tickets`, `consent_events`, `payment_links`, `wallet_transactions`, `client_webhooks`, and `clients` itself, keyed on `id` rather than `client_id`). `broadcast_recipients` needed a new denormalized `client_id` column first — it only carried `broadcast_id`
- [x] **Deviation from plan, found by investigating first, not assumed:** a plain `current_client_id()` JWT-resolving helper isn't enough on its own — this app connects to Postgres as Supabase's `postgres` role, confirmed live to have `rolbypassrls = true`. Enabling RLS with no other change would have been a complete no-op. Fix: a new restricted `wasi_app` role (`NOLOGIN`, `NOBYPASSRLS`) that ordinary client requests run as, switched into per-request via `SET LOCAL ROLE` inside a transaction (`server/src/middleware/tenantContext.js`), with `app.current_client_id` set the same way — the privileged `postgres` connection is kept for admin routes, the Meta webhook, `broadcastRunner`, and a few pre-auth/system paths
- [x] Policies keyed off `current_setting('app.current_client_id', true)` — not literally the CRM's `0021_integration_settings.sql` pattern (never read that file directly; built independently for this app's actual connection model, which has no Supabase Auth JWT reaching the database the way PostgREST-based RLS normally assumes)
- [x] **Revoked column privileges** on `wabas.access_token_encrypted` (and, going further than originally scoped, `clients.password_hash`) so only the privileged connection can read them
- [x] Kept the app-layer `WHERE` clauses — defence in depth, not replaced
- [x] Tested cross-tenant access is genuinely blocked at the DB: `server/test/tenantIsolation.test.js` runs a query with **no** `client_id` filter in the SQL at all and proves it still returns only the current tenant's rows — the actual proof this is DB-enforced, not app-enforced — plus proof the admin path and `broadcastRunner`'s cross-client listing still work, and that the token column really is unreadable by the restricted role

Two real bugs found and fixed while building this, both against the live dev database, not caught by review alone: a wrong call site (a repo function was passed the connection pool object as a query parameter by mistake) caught immediately by the new tests; and a genuine Postgres gotcha where a custom session GUC defaults to `''` (not `NULL`) after the transaction that first set it ends, which would otherwise make an unscoped query throw instead of cleanly denying access — fixed with `nullif(current_setting(...), '')` in the policy expressions.

> Retrofitting this after clients are live would have been significantly harder. Done before onboarding anyone real.

---

## PHASE 4 — Opt-in tracking (half a day) — DONE (commit `d8a7a0d`)

No consent column existed anywhere. `contacts.status` was generic, not WhatsApp consent.

This was a compliance gap, not a missing feature. Sending to non-consenting numbers destroys quality ratings — and **quality is portfolio-level**, so one client's bad sending affects every other client's messaging tier. Motivated directly by a live near-miss during Phase 2 verification: the broadcast worker nearly sent an unsolicited template to a real personal number.

```sql
alter table contacts
  add column opt_in_status text not null default 'unknown'
    check (opt_in_status in ('unknown','opted_in','opted_out')),
  add column opt_in_source text,
  add column opt_in_at timestamptz,
  add column opt_out_at timestamptz;
```

- [x] Blocks marketing broadcasts (and marketing chat sends, the enforcement point is `messagingService.sendChatMessage`, not just the broadcast path) to anything not `opted_in`; a template whose category can't be resolved locally fails closed and is treated as marketing
- [x] Auto-sets `opted_out` on STOP-type inbound messages, including Tamil/Tanglish variants (best-effort list, not native-speaker-verified)
- [x] Surfaced opt-in state, source, and date in the contact UI, plus a skipped-for-consent count on broadcast results and a pre-send warning when most of the audience hasn't opted in
- [x] Records source in an append-only `consent_events` table, separate from the current-state column on `contacts` — exactly what you'd need if challenged
- [x] Existing contacts default to `unknown`, never backfilled to `opted_in` — verified live against the real seeded demo contacts

---

## PHASE 5 — Hub capability (1.5 days)

This is what turns Wasi from a standalone product into the centre. Without it, GV Mart and the CRM can't consume it.

### 5.1 Send API

```
POST /api/v1/messages
Authorization: Bearer <per-app API key>
{ client_id, to, type, template?, params?, body? }
```

- [ ] New `api_keys` table: app name, client_id, hashed key, revocable, last_used_at
- [ ] Validate the key, resolve the tenant, reuse the existing `metaClient.js` send path
- [ ] Return Meta's error body on failure — do not swallow it
- [ ] Enforce existing plan limits

### 5.2 Template API

```
POST /api/v1/templates    create + submit
GET  /api/v1/templates    list with status
```

- [ ] Same auth model as above

### 5.3 Inbound forwarding

```sql
alter table wabas
  add column forward_to_url text,
  add column forward_secret text;
```

- [ ] After the webhook persists an inbound message, POST it to that WABA's `forward_to_url`
- [ ] Sign with HMAC so the receiving app can verify origin
- [ ] Retry with backoff; log failures distinctly so they're alertable
- [ ] Forward `message_template_status_update` and `account_update` too — a consuming app needs to know when its own WABA is restricted

---

## PHASE 6 — Super admin (1 day)

Requires Phase 3. Build it on RLS, not before.

- [ ] **Separate role, not a flag.** Wasi has one tenant-wide JWT type today. Super admin bypasses tenant scoping by design and needs its own auth path and its own policies.
- [ ] **Read-mostly.** Resist adding send-on-behalf-of or template editing. Small blast radius when something goes wrong at 2am.

Views to build:

- [ ] **Clients** — tenant, WABA, phone number, connection status, plan, connected date
- [ ] **Health** — quality rating, messaging tier, restriction status, forwarding failures. This is the daily-check screen.
- [ ] **Templates** — every client's templates and statuses. Wasi receives all `message_template_status_update` webhooks, so this is its natural home.
- [ ] **Volume** — sends per client per day, for billing and for portfolio-limit awareness
- [ ] **API keys** — which app, which tenant, revoke
- [ ] **Failures** — failed sends with Meta error codes, forwarding failures

### 6.1 Webhook-receiver uptime alerting — specific item, not generic "add monitoring"

Found live during Phase 2: an unlistened `pg.Pool` `'error'` event (Supabase's pooler dropping an idle connection — routine on their end) crashed the whole process twice, silently. In local dev (`--watch`) it stayed down until a file change triggered a restart — once for roughly two hours, undetected, because nothing was watching for it. The immediate cause is fixed (`pool.js`, `broadcastRunner.js`, and `seed.js` now all attach `'error'` listeners to every pool/client they hold; `index.js` also has `process.on('unhandledRejection'/'uncaughtException')` as a backstop for whatever the *next* one turns out to be) — but the actual gap this exposes is bigger than the bug: **there is no monitoring or alerting anywhere in this repo.** `render.yaml` sets `healthCheckPath: /health`, which affects Render's own deploy/restart behavior, but nothing external polls it or notifies a human if it fails.

This matters specifically for Wasi because of one fact: **Meta retries a failed webhook delivery for up to 7 days, then discards it permanently — no event log, no replay API.** A crash at the wrong moment, for long enough, doesn't degrade service — it loses client messages with no recovery path, silently, possibly for days before anyone notices via a client complaint.

- [ ] External uptime check against `/health` (UptimeRobot, Better Uptime, or similar) with alerting (email/SMS/Slack) on failure — this is the minimum viable fix, doesn't require building anything
- [ ] Confirm Render's actual restart behavior for this service empirically (kill the process, time the recovery) rather than assuming — a web service should get restarted by Render's own supervisor, but verify rather than infer, same standard as the rest of this plan
- [ ] Once the super admin panel exists, surface "last successful webhook processed at" per WABA on the Health view — a stale timestamp is a more specific signal than generic uptime
- [x] ~~Consider whether a crash mid-webhook-processing needs Meta to actually retry~~ — **done**: found live during this same verification pass that it did NOT retry (per-change errors were caught, logged, and the handler still returned 200 regardless — the identical failure shape, "failed write, swallowed error, 200 returned," that caused the Sirah CRM incident this plan already references). Fixed: `metaWebhook.js` now tracks whether any change genuinely failed to process (as opposed to a field with no handler at all, which is not a failure and still returns 200) and returns 500 if so, so Meta retries the whole payload. Safe because inbound inserts are idempotent on `meta_message_id` — reprocessing an already-succeeded change costs nothing, a lost one is unrecoverable after 7 days. Covered by a regression test with a real DB constraint violation (`server/test/metaWebhookDispatch.test.js`).
- [ ] **New risk introduced by the fix above, needs its own alert**: Meta can disable a webhook subscription after sustained non-2xx responses (exact threshold undocumented — verify against current Meta docs before relying on a number). A prolonged outage now fails loudly (500s) instead of silently (200s), which is the right tradeoff, but "loudly" only helps if something is listening — this is the concrete reason §6.1's uptime alerting can't be optional. The `console.error('metaWebhook FAILURE:', ...)` log line is deliberately structured and distinctly grep-able from routine "unhandled field" warnings specifically so it can be wired to an alert before Meta's own disable-threshold is reached, not after.
- [x] **Related config gap, found during Phase 3, fixed:** `pool.js`'s `pg.Pool` had no `connectionTimeoutMillis` set. Harmless when `pool.connect()` was called from a handful of places, but Phase 3's `tenantContext.js` middleware now calls it on *every* client-authenticated request — a single transient Supabase pooler blip during testing hung a connection attempt for over 4 minutes with no error, because Node had no timeout to fall back on and just waited on the OS's own TCP timeout. Fixed with a 10s `connectionTimeoutMillis`. **The gap this points at is bigger than this one setting**: nothing in this codebase has been audited end-to-end for missing timeouts (Meta API calls via `metaClient.js`, Razorpay calls, `fetch()` calls in `forwardToClientWebhook`) — each was written assuming the network behaves, none has been verified against an induced hang the way this one now has. Worth a dedicated pass before relying on any of them under real production load.

**Checkpoint after Phases 1–4:** the two items above that are still unchecked — external uptime alerting, and Render's actual restart behavior — remain genuinely unverified, not just undocumented. Nothing in Phases 1–4 touched either of them.

### 6.2 Embedded Signup has never actually been run

Every live verification in Phase 2 used a WABA connected by pasting a real `waba_id`, `phone_number_id`, and system-user token directly into the database — not by going through `/api/onboarding/whatsapp/connect`, the actual code path a real client would use (Meta's `FB.login()` popup → `config_id` → authorization code → `metaClient.exchangeCodeForToken` → `exchangeForLongLivedToken` → `subscribeAppToWaba` → `registerPhoneNumber`). That path is implemented and has exactly one test against it (`onboarding: whatsapp connect fails cleanly with a bogus code`, confirming a real 502 for a fake authorization code) — it has never been exercised with a real one. Everything downstream of it (the send path, the webhook, templates, RLS, opt-in tracking) is now verified; the front door a real client actually walks through to get there is not.

- [ ] Run Embedded Signup end-to-end at least once with a real Meta test user / test WABA before onboarding anyone who isn't this developer
- [ ] Confirm the frontend's `embeddedSignup.js` (the `FB.login()` + `config_id` popup flow) actually matches what `/api/onboarding/whatsapp/connect` expects — never checked together in a real browser against a live Meta app

---

## PHASE 7 — Switch the default webhook (2 hrs)

Only after Phases 1–5 are verified working.

- [ ] Point Meta's default callback URL at Wasi
- [ ] Set a webhook override on the CRM's WABA so the CRM keeps receiving its own messages
- [ ] Or migrate the CRM to consume Wasi's API and drop its direct Meta code
- [ ] Verify both still send and receive

---

## PHASE 8 — Connect GV Mart

- [ ] Rotate GV Mart's exposed keys first — its own `TODO_before_prod.md` flags a live service_role key and plaintext DB password in a dev `.env`
- [ ] Register GV Mart as an API consumer, get a key
- [ ] Set `forward_to_url` on Ramesh's WABA → GV Mart's Edge Function
- [ ] Replace `send_whatsapp_stub()`'s behaviour with a call to Wasi's send API — keep the `whatsapp_outbox` insert as an audit log
- [ ] New GV Mart Edge Function receives forwarded messages, writes `direction='inbound'`
- [ ] A failed send must never roll back a ticket creation or invoice generation

### Ramesh's onboarding — use Coexistence

- [ ] He picks "Use a new or existing WhatsApp number", not "display name only"
- [ ] Scans a QR from his WhatsApp Business app
- [ ] He keeps using WhatsApp Business on his phone; GV Mart sends through the API on the same number; history syncs both ways
- [ ] Prerequisites to tell him: number on the WhatsApp Business app ≥7 days, app version 2.24.17+, phone with a camera
- [ ] **Warn loudly:** the Business Manager choice is permanent after registration
- [ ] Tell him what stops working: group chats don't sync to the API, disappearing messages off, view-once and live location disabled, edit/revoke unavailable on 1:1
- [ ] Tell him he pays Meta directly for message volume — Independent Tech Provider model

---

## Product gaps — real, but not blocking the hub

From the audit, weakest as a sellable product:

- **Team inbox** — currently a teammate directory. No chat assignment column, no per-agent auth, no per-agent visibility.
- **Automation** — single-step keyword replies only. No branching, delays, or sequences.
- **Analytics** — two endpoints, 7-day window. No dashboards, exports, or trends.
- **Media messages** — inbound image/audio/doc stored as a `[type]` placeholder, not fetched or decoded.
- **Billing** — Razorpay works but cancellation is one-off-order-based, not a true recurring cancel.

These follow clients rather than precede them. Build what a paying client actually asks for.

---

## Order and effort

| | Phase | Effort | Blocks | Status |
|---|---|---|---|---|
| 0 | Git + credentials | 30 min | Everything | Done |
| 1 | Named parameters | 2 hrs | Templates working at all | Done |
| 2 | First real message | 4 hrs | Trusting any of this | Done except step 6 (blocked on Meta, not code) |
| 3 | RLS | 1 day | Onboarding real clients | Done |
| 4 | Opt-in tracking | 4 hrs | Marketing sends, compliance | Done |
| 5 | Hub capability | 1.5 days | GV Mart, CRM consuming Wasi | Not started |
| 6 | Super admin | 1 day | Operating at >3 clients | Not started |
| 7 | Switch default webhook | 2 hrs | — | Not started |
| 8 | Connect GV Mart | 1 day | Ramesh going live | Not started |

**Roughly one working week to hub-ready** *(original estimate)*. Phases 1–4 are done; Phases 5–8 haven't been re-estimated against what actually shipped, so this total is left as the original plan, not a current forecast.

---

## Open question worth deciding

Ramesh is a real client with a real need. Wasi is a week away from being a trustworthy hub.

**Option A** — build Wasi first, connect GV Mart to it in Phase 8. One migration, done properly.

**Option B** — connect GV Mart directly to Meta with a webhook override this week (one day), get Ramesh live, then move him onto Wasi when it's proven. Costs about a day of rework; buys a live client and lets Wasi be hardened without a client depending on it mid-build.

Option B is the lower-risk sequencing if Ramesh is waiting.

---

## Unrelated but still outstanding

Both surfaced during the CRM work and neither is done:

- **Migration automation.** DDL has been pasted by hand five times because the Supabase CLI authenticates as a team member's Gmail while the project sits under the Microsoft login. That account split is what allowed fourteen migrations to silently drift on the CRM. Gated GitHub Actions — migrations run, and only on success does the deploy fire.
- **Alshifa audit.** Live at ayushiwis.com with real patients. Never checked for the same migration drift that silently destroyed every inbound WhatsApp message on the CRM for weeks. Twenty minutes.
