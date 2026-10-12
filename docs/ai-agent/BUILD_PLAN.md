# Wasi — Outstanding Work and End-to-End AI Agent Build Plan

**Owner:** Sirah Digital
**Date:** 12 October 2026
**Status of truth:** verified against the repository and production database as of this date. Anything marked `UNVERIFIED` has not been confirmed and must be checked before it is relied on.

---

## 0. How to read this document

This document has two jobs.

1. **Sections 1–4** record the real state of Wasi — what is broken, what is unfinished, what was found and never fixed. This is the backlog. It exists because nine days of work on the AI feature kept surfacing production problems that outranked it, and those problems were triaged in chat rather than written down.
2. **Sections 5–11** are the end-to-end build plan for the AI bot reply feature, from the current zero state to a feature clients can buy. Each phase has a definition of done that can be checked without asking anyone.

**Section 12 is the prompt to paste into a Claude Code planning session.** Paste it before writing any code. It will produce an implementation plan that this document cannot, because it can read the actual files.

**Rule for the whole document:** nothing in Section 5 onwards starts until Section 2 is clear. The reason is in Section 2 itself.

---

## 1. Current state

### 1.1 What exists and is correct

| Thing | State |
|---|---|
| `docs/ai-agent/SPEC.md` | **Current version is as amended at `8c1e075`** (decision 14, sections 10.5/13/20); first committed at `7226a637` (full SHA `7226a6370d9f…`). Cite `8c1e075`, not `7226a637`, for the current text. 20 numbered sections (1–20; the file also has a section 0 and a closing sequencing note, 22 `##` headings in all). Verified against the codebase — the `users(id)` error, the migration-number error and the gate-4 logic error were all corrected before commit. **This is the source of truth for the AI feature. Read it, do not re-derive it.** |
| Admin credential rotation | Done twice. `token_version` bumped to 2. No secrets are reachable through admin routes, so client WABA tokens did **not** need rotating. |
| `server/scripts/set-password.js` | Written. Hidden prompt, 14-character minimum, bumps `token_version`, writes an audit row, never logs the value. **Uncommitted.** |
| Echo ingestion | **Not fixed; corrected 2026-10-12.** The code path exists (`907b71d`), but the app is still **not subscribed** to `smb_message_echoes`: a live `GET /{app-id}/subscriptions` returned `messages, account_update, message_template_status_update, phone_number_name_update, message_template_quality_update, phone_number_quality_update` and nothing else. No echo has ever been delivered (zero echo rows in `audit_log`, zero `messages.source='whatsapp_app'`). Subscribing is a human dashboard action, and per 3.0 it must not happen before production runs `cb27227`. *(Verification note 2026-10-12: the dashboard subscription state and the echo payload shape were not re-checked in this pass. `SPEC.md` decision 14 still lists the payload shape as not confirmed against a live capture.)* |
| `metaWebhook.js` field guard | Fixed. `field !== 'smb_message_echoes'` now prevents echoes being processed as inbound messages. **Verified 2026-10-12:** guard present at `server/src/routes/metaWebhook.js:575`, committed in `cb27227`; the file has no uncommitted changes. **Not in production:** `cb27227` (3 Oct) is after `511ea49` (1 Oct), so the deployed server has no guard; see 3.0. |
| TNPSC diagnosis | Complete. The stored WABA (`894384560175844`) is not the WABA Meta says owns the phone number (`1649658386105751`). Inbound has been discarded since 23 September. The diagnosis is done; the fix is not. |
| Encryption | `server/src/utils/encryption.js` — AES-256-GCM, key derived from `SERVER_SECRET`. Local development cannot decrypt production tokens. **This is correct behaviour and must not be "fixed".** |

### 1.2 What does not exist

- **No AI feature code at all.** No migration, no model call, no `ai_jobs` table, no agent configuration, nothing. Phase 0 has not started.
- **No database backups.** `"backups": []`, `pitr_enabled: false` on the Wasi Supabase project (`exvoupxpocybjcxmkuac`). This is why GV Mart's deleted messages are unrecoverable. *(Re-verified 2026-10-12 via the Supabase Management API, `GET /v1/projects/exvoupxpocybjcxmkuac/database/backups`: `backups: []`, `pitr_enabled: false`, `walg_enabled: true`.)*
- **No API request log.** When a client asks "did my call reach you?", there is no way to answer.
- **No send-failure alerting.** GV Mart lost 55 of 66 outbound messages in 48 hours and nobody at Wasi noticed.
- **No multi-number support.** `wabasRepo.findByClientId` returns the newest WABA only.

### 1.3 The thing that keeps happening

Every attempt to start the AI feature has been interrupted by a production problem that was more urgent. That is not bad luck — it is a signal that Wasi has no operational floor. There is no backup, no request log, no failure alerting, and no enforcement on `clients.status`. Until those exist, any feature built on top will keep being interrupted by the floor giving way.

Phase 0 of the AI feature happens to build three of the four missing floor pieces. That is the argument for doing it, independent of whether the bot ever ships.

---

## 2. Blocking work — nothing else starts until this is clear

These are live, they affect paying clients, and three of them are getting worse by the day.

### 2.1 Run the `debug_token` script

**Status:** written 9 October. **Never run.** Nine days.

**Why it is first:** four clients are failing with what is probably one cause.

| Client | Symptom |
|---|---|
| TNPSC | Meta error `#200` |
| Sirah Digital | Meta error `#100` |
| GV Mart | Meta error `#100` |
| Evokz | "This WhatsApp Business account does not have permission to create message template" |

One run of `debug_token` prints the granted scopes, the token's owning app and the WABA bindings for each stored credential. That output either confirms a shared permission gap or splits the four into separate problems. Either way, four client investigations collapse into one.

**Already disproved:** the hypothesis that Evokz is blocked by incomplete business verification (`#141010`). Fortune Innovatives is also unverified and has 22 approved templates. Business verification is not the blocker. Do not spend more time on that theory.

**Definition of done:** the script's output is pasted into this document as Appendix A, and each of the four clients has a named cause.

### 2.2 GV Mart — 55 of 66 sends failing

**Status:** happening right now.

In the last 48 hours, 55 of GV Mart's 66 outbound messages failed with `session_window_closed`. The cause is behavioural, not technical: they send free text to customers whose 24-hour window has closed, where an approved template is required.

**What they need:**
1. Approved utility templates covering their actual customer notifications (order confirmation, dispatch, delivery, payment).
2. To be told that free text outside the window will never work, and why.

**Blocked by 2.1** if their `#100` turns out to be a template-creation permission problem.

**Definition of done:** GV Mart has at least three approved templates covering their notification cases, and their 48-hour failure rate is under 10%.

### 2.3 Send-failure alerting

**Status:** not built. `alertRunner` already exists and is the right place for it.

The only reason 2.2 was found is that someone went looking. Build the alert so the next one finds itself.

**Minimum viable rule:** for each client, over a rolling 6-hour window, if `failed_sends / total_sends > 0.3` and `total_sends >= 10`, raise an alert. Separate the alert by failure reason, because `session_window_closed` is a client-behaviour problem and `waba_not_connected` is a Wasi problem, and they need different responses.

**Definition of done:** the rule fires on a synthetic test, and GV Mart's current state would have triggered it.

### 2.4 Tell GV Mart their data is gone

**Status:** six days old.

1,738 messages were deleted. There is no backup, no PITR, and their own Supabase project holds only 2 inbound rows from 6 October. There is no recovery path except a Supabase support ticket, which is unanswered.

This conversation gets harder every day it is delayed. It should happen whether or not the ticket is resolved.

### 2.5 Supabase support ticket

**Status:** send or chase.

Autovacuum is still frozen on `messages`, `chats` and `contacts` while waiting for a reply. That freeze cannot stay indefinitely — dead tuples accumulate and query planning degrades. Set a decision date: if there is no useful reply by that date, abandon the recovery, re-enable autovacuum, and close 2.4 honestly.

### 2.6 Evokz

**Status:** needs a message sent.

Ask Evokz to complete business verification and add a payment method. Note that per 2.1 neither of these is the confirmed cause of their template failure — they are prerequisites for sending at scale regardless, and asking for them is useful on its own. The authentication template stays blocked until 2.1 explains the real cause.

**Known complication:** `buildAuthenticationPayload` at `server/src/utils/metaClient.js:677` posts to `/{waba}/message_templates` with a singular `language` field. Meta documents authentication templates via `POST /<WABA_ID>/upsert_message_templates` with a `languages` **array**. The comment at line 671 admits the shape is not confirmed against live Meta. **This code has never successfully run against Meta.** Expect it to be wrong, and fix it as part of the Evokz work rather than treating a failure as a permissions problem.

> **Verified 2026-10-12.** Confirmed in code: `buildAuthenticationPayload` is at `metaClient.js:677` and emits a singular `language` (default `'en_US'`); it only *builds* the payload, which `createMessageTemplate` then posts to `/{wabaId}/message_templates`. The "not doc-confirmed live" comment is at lines 668–676 (the admission is on 671). **Not verified here:** Meta's documentation for `upsert_message_templates` / `languages` was not re-read in this pass. **Evidence for "never run":** production has two approved Authentication templates (`signup_otp2`, TNPSC mentors, 17 Sep; `test_message`, Sirah Digital, 21 Sep), but both have `auth_options` NULL, which this app's create path persists. That is consistent with both having been created outside this code and synced in. It is an inference from the data, not proof (a created-then-deleted template would leave no row).

> **Added 2026-10-12 — where those two templates came from.** `messageTemplatesRepo.create` (`messageTemplatesRepo.js:58-82`) always writes a non-null `auth_options` object for an Authentication template, whichever route called it (`POST /api/templates` or the Hub API). Template sync's insert path (`templateSyncService.js`, the `toInsert` branch) does not write `auth_options`, and its update branch never touches it. A NULL `auth_options` with a `meta_template_id` therefore means the row was **synced in from Meta, i.e. the template was created directly in Meta (WhatsApp Manager or Graph API), not through Wasi's code.** Both also carry language `en`, not Wasi's `en_US` default, which is consistent. **Immediate route for Evokz that does not depend on fixing `buildAuthenticationPayload`:** have the template created in WhatsApp Manager on Evokz's WABA, then run template sync. **Caveat, untested:** Evokz's error is a WABA-level permission refusal; if it is enforced by Meta on the WABA rather than on the API, WhatsApp Manager may refuse too. 2.1's `debug_token` output decides that.

---

## 3. Correctness bugs found and not fixed

These were all found during the investigation and written down nowhere but chat. They are real, they are small, and each one will eventually cost a client conversation.

### 3.0 Production is behind master

**This outranks everything else in section 3.** Added 2026-10-12 from a read-only investigation. Findings 1–3 below.

**Production is running the build of commit `511ea49` (1 Oct 14:27 IST); `master` has 24 commits since.** The live `index.html`, `app.js` and `index.css` each match `511ea49` byte for byte (CR-stripped md5). Server code is from the same image build.

**1. The echo guard is not in production, but nothing is exposed yet.**
- `cb27227` (the `smb_message_echoes` guard, `metaWebhook.js:575`) is **after** `511ea49`; it is not an ancestor of it. Production has the echo handler (`907b71d`, 25 Sep) but not the guard.
- The Meta subscription for `smb_message_echoes` is **not live** (checked live 2026-10-12; field list in 1.1). No echo has ever been delivered: zero echo rows in `audit_log`, zero `messages` with `source='whatsapp_app'`, zero contacts matching any WABA's own number, zero inbound messages from such contacts, zero `meta_message_id` seen in both directions.
- **What the unguarded path would do:** only if Meta sent an echo with its array under `value.messages` (Meta documents `value.message_echoes`, which the unguarded code handles correctly) would `handleInboundMessages` ingest the business's own outgoing message as an inbound customer message: a contact for the business's own number, a chat, an inbound row, flow-engine and keyword-automation runs, and a forwarded `message.received`.
- **Rule:** deploy `master` **before** anyone subscribes the echo field in the Meta dashboard.

**2. The deploy gap: 24 commits.** Server code differs in four files (`contactsRepo.js`, `metaWebhook.js`, `seedLandingDemo.js`, `teardownLandingDemo.js`); no migrations and no dependency changes.

| Group | Commits |
|---|---|
| Production correctness | `de4bdeb` (fixes `/design-system.css`, currently HTTP 500), `531395e` (UI survives a failed CSS load), `1d7f200` (primary tag written to `contact_tags`; segments and tag analytics stop missing tagged contacts), `892300c` (duplicate tag chip), `351d133` (fake chart removed), `4f29fc4` (test quarantine) |
| Security / hardening | `cb27227` (echo guard). `a988716` (stop tracking the scheduler lock) is hygiene |
| Features | `74d510f`–`995ce8b` (client app, admin console, single landing page, signup, flow-editor redesign), `4872452` and `12f67d6` (mobile), `969e51b` (landing demo seed, manual-run only) |
| Docs | `7226a63`, `8c1e075`, `4458a75`, `9a97664`, `4235a24`, `f55a97c`, `37cd0ed`, `65c5a2c` |

A deploy turns on essentially the whole redesign (about 6,000 lines of UI change; admin `app.js` alone is +2,500). CLAUDE.md records that the final full-suite run for that redesign never completed, so treat the deploy as carrying untested risk and smoke-test the admin console first.

**3. Why it is stale.**
- **Production is a VPS, not Render.** The live site answers as `nginx/1.24.0 (Ubuntu)` at `187.77.186.31`, with no Render headers, serving a Docker image. `render.yaml` and `DEPLOY.md` describe a path that is not the live one and are stale.
- **There is no auto-deploy and no CI** (no `.github/`). The mechanism is manual: `deploy.sh` runs `docker compose build`, a gated `node-pg-migrate up`, then `docker compose up -d`. A `git pull` on the box is a prior manual step.
- **No evidence of failed deploys; it is simply not run since about 1 Oct 14:32 IST** (the served `index.html` `Last-Modified`). Nothing in `511ea49..master` can fail the migration gate (no migrations) or the build (`package*.json` unchanged; one Dockerfile change, the `design-system.css` COPY fix).
- **Cannot be determined from the repo; check on the VPS:** `git log -1` and `git status` in the checkout (dirty? other branch?), `docker images wasi-crm-server` (created date), `docker compose logs --tail` for the last restart, that `server/.env.production` is present, and the checkout's `git remote -v` (see 4.1).

### 3.1 Fabricated Analytics chart — production

There is a hard-coded chart in the Analytics view captioned **"Last 7 days, live from your account."** It is not live and it is not from their account. A client who checks this against their Meta dashboard will find Wasi showing them invented numbers.

> **Verified 2026-10-12 — the situation is more specific than written above:**
> - **Where:** the caption is `index.html` (repo root) line 965 at HEAD, and line 912 of the file production serves. The fabricated chart is the inline `<svg>` immediately below it ("Messages (daily)", "Past 7 days").
> - **Production serves it; `master` no longer contains it.** The live `https://wasi.sirahagents.com/` `index.html` is byte-identical (CR-stripped md5 match) to `index.html` at commit `511ea49` (UI redesign stage 4, 1 Oct 14:27 IST; response `Last-Modified` 1 Oct 09:02 GMT). The chart was removed on `master` in `351d133` ("Analytics (no fake chart)", 1 Oct 15:33 IST), which is not deployed. At HEAD, line 965 is a caption above the real summary tiles, followed by an honest "Daily trend isn't available yet" empty state.
> - **Which file is served:** the repo-root `index.html`, via `server/src/app.js:220-221` (`sendFile` from `REPO_ROOT`), copied into the image by `Dockerfile:39`. There is no build step and no `client/` directory for it (the only build is the Vite one for `flow-editor/`). So production is simply running an older image.
> - **Hard-coded, not mislabelled.** The chart is literal SVG: fixed `<path d="M 40,170 Q 300,168 …">` coordinates, fixed y-axis labels 0/200/400/600, and fixed x-axis labels "Sun Jul 26 … Sat Aug 01" (a week in July/August). No script touches it; `app.js` only fills six metric tiles from `GET /api/analytics/messages` (a real 7-day aggregate). So the chart is **delete**, not recaption. The caption is accurate for those tiles, which is what makes the chart beneath it misleading.
> - **Consequence for the fix:** the code change is already on `master`. What is outstanding is a **deploy** of `master`, which also carries everything since 1 Oct (including the `design-system.css` Dockerfile fix: production currently returns HTTP 500 for `/design-system.css`).

**Fix:** remove the chart, or replace it with real data, or recaption it honestly. Removing it is fastest and is the right default — a missing chart is better than a lying one.

**Priority:** high, because it is a trust problem, not a bug.

### 3.2 `language` not accepted on template sends

The Hub API send payload has no `language` field:

```json
{
  "client_id": "00000000-0000-0000-0000-000000000001",
  "to": "919876543210",
  "type": "template",
  "template": "shipping_update",
  "params": { "name": "Ramesh" },
  "headerMediaUrl": "https://example.com/file.pdf"
}
```

Language is resolved by looking up the template name and taking the newest `created_at`. `po_quote_request_doc_v3` exists in both `en` and `en_US` **with identical timestamps**, so which one sends is a coin flip.

> **Verified 2026-10-12.** `apiMessageSendSchema` (`validate.js:658`) has no `language` field. Resolution is `messageTemplatesRepo.findByNameAndClient` (`messageTemplatesRepo.js:22-24`): `order by created_at desc limit 1`, with no status or `orphaned_at` filter. Both rows exist, both `approved`, both under the demo client `00000000-0000-0000-0000-000000000001`, both `created_at = 2026-09-08T13:24:03.793Z`.

**Fix:** accept an optional `language` on the payload. When absent, resolve deterministically (prefer exact `en`, then any `en_*`, then error if ambiguous) rather than by timestamp. Document the field in the API reference.

### 3.3 `onboarding.js:181` — a second connect attempt kills a working number

The route overwrites the existing `wabas` row and sets `status = 'connecting'` **before Meta is called.** If the Meta call then fails, the client is left with a broken row and a disabled number that was working a moment earlier.

> **Verified 2026-10-12.** The write is `onboarding.js:181` (`wabasRepo.upsertForClient`), before `exchangeCodeForToken` at line 187. `upsertForClient` (`wabasRepo.js:56`) updates the client's *newest* row in place, and the call sets `waba_id` and `phone_number_id` to `null` when the request omitted them, as well as `status='connecting'`. The failure path (`onboarding.js:294`) then sets `status='failed'`. There is no guard for an existing `connected` row.

**Fix:** do not mutate the existing row until Meta confirms. Write to a staging row or hold the change in memory and commit on success.

### 3.4 Instagram migrations 081/082 are stranded

Migrations 079 and 080 are applied (confirmed in `pgmigrations`, 25 September). 081 and 082 are Instagram work and are stranded — they sit below the highest applied number on master (085) and will never run in order.

> **Verified 2026-10-12.** `pgmigrations` highest applied is `085_payment_reminder_schedules` (id 76, run 1 Oct); there are no 081/082 rows. The highest file on `master` and `origin/master` is `085_…`. `081_instagram_accounts.js` and `082_instagram_conversations_messages.js` exist **only** on `feature/instagram-phase-1` (local and origin), not on `master`, so they become stranded when that branch lands.

**Fix:** renumber them to the next free numbers at the time of the fix. **Never pre-assign a migration number in a plan or a spec** — take the next free one at implementation time. This document deliberately does not name any migration numbers for that reason.

### 3.5 GV Mart is on the demo client

**Replaced 2026-10-12 (the earlier version of this section had the shape wrong).**

GV Mart runs entirely on the **demo client**, not on its own Wasi client.

- GV Mart's own Wasi client (`4b09813e-99c8-46de-9429-0fb0b25be62f`) has `status = 'pending_setup'`, a WABA that is `connected` (7 Oct) with no forward configured, and its own API key (`CRM Integration`, created 7 Oct) that has **never been used** (`last_used_at` null).
- The demo client (`Wasi Demo Client`, `00000000-0000-0000-0000-000000000001`) has `status = 'active'`. Its WABA's `forward_to_url` points at host `fsunrjithwcjtsutsgea.supabase.co` (GV Mart's backend, per 4.4), forwarding `message.received`, `message.status`, `message_template_status_update` and `account_update`. Its `CRM Integration` API key was last used **2026-10-12 13:23 UTC**, i.e. today.
- **Attribution caveat:** Wasi has no API request log (3.6), so "the demo key is GV Mart's" rests on the forward target and on what GV Mart has reported, not on a per-caller record.
- The `whatsapp_provider_credentials` row named in the earlier version is not in Wasi's database; it would be in GV Mart's own Supabase project, which was not accessed. Its `client_id` and its "used on 8 October" date remain unverified.

**Consequences**
- The demo forward (data on the demo client's `wabas` row; `forwardRunner.js` has no demo-specific code) **cannot be removed** until GV Mart is moved to their own client id.
- **Phase 0.5 (`clients.status` enforcement) MUST NOT ship before GV Mart is on a real, `active` client row.** Today GV Mart's own client is `pending_setup`; enforcement that blocks non-`active` clients would cut off their own row the moment any traffic is attributed to it (their own key or WABA). It is also a wider issue: of the 14 non-test clients, 8 are `pending_setup` (5 of them with a connected WABA, none having sent in the last 14 days) and 6 are `active` (4 sent in that window, the demo client among them). Enforcement would block those 5 connected `pending_setup` clients as soon as they send. Fix the status values first, then enforce.
- **Fix:** create or activate a proper client row for GV Mart, migrate their credentials, chats, messages and templates onto it, verify their sends still work, then remove the demo forward.
- **Risk:** this touches a live client's message history. Do it as a transaction with a verified rollback, during a quiet window, and prove the row counts match before and after.

### 3.6 No API request log

Build one. Minimum: timestamp, client id, route, status code, error code, latency, and a truncated request id — **not** the payload, which contains customer phone numbers and message bodies. Retention 30 days.

This exists so that "did my call arrive?" has an answer. It is also the only way to charge for API usage honestly later.

### 3.7 Multi-number is not supported

`wabasRepo.findByClientId` at `server/src/repositories/wabasRepo.js:14` ends in `ORDER BY created_at DESC LIMIT 1`. There are roughly 30 call sites that assume one WABA per client.

> **Verified 2026-10-12.** Line 14 is the function declaration; the `order by created_at desc limit 1` SQL is line 15. Count of `wabasRepo.findByClientId` call sites in `server/src`: **25 direct calls in 10 files** (`admin.js` 9, `onboarding.js` 4, `templates.js` 4, `clientNotifier.js` 2, and one each in `apiV1Account.js`, `apiV1Templates.js`, `broadcasts.js`, `templateLibrary.js`, `messagingService.js`, `templateSyncService.js`) plus one internal call inside `upsertForClient`, which itself has 8 callers (`admin.js` 4, `onboarding.js` 4). So "roughly 30" holds (25, or 33 counting `upsertForClient`'s callers). A further 28 lines in `server/test` reference it. The shared send choke point is `messagingService.getSendableWaba` (`messagingService.js:35`); `broadcastRunner.js` and the flow runners do not call it directly.

The correct model is **phone numbers as their own table under a WABA** — a WABA can hold several numbers, and the client picks per send. Estimated 1.5–3 weeks.

**Do not start this during the AI build.** It touches 30 call sites including every send path, and interleaving it with the AI feature means neither lands. Schedule it after Phase 2.

---

## 4. Security and infrastructure

### 4.1 Make the repository private

**Order matters and getting it wrong breaks production.**

> **Corrected 2026-10-12.** Production is a **VPS** (nginx on Ubuntu, `187.77.186.31`, Docker Compose, manual `deploy.sh`), not Render; see 3.0. `render.yaml` and `DEPLOY.md` describe Render and are stale, so the steps below stand. What the repo cannot tell us is how the VPS currently authenticates to GitHub: the repo's `origin` is the anonymous HTTPS URL `https://github.com/Jesheeba/Wasi.git`, and the VPS's own remote config is only on the VPS. If it pulls over anonymous HTTPS, going private breaks the deploy. If it already uses SSH or a token, it may not. Check `git remote -v` in the VPS checkout first. If a Render service still exists, it needs the Render GitHub app installed on the repo, or it breaks the same way.

1. Create a deploy key for the VPS.
2. Add the public half to the repository's deploy keys.
3. Change the VPS remote to the SSH URL.
4. **Prove it:** `git ls-remote` over SSH from the VPS, successfully, while the repository is still public.
5. Only then flip the repository to private.

An unauthenticated `git pull` fails on a private repository. Flipping first breaks the deploy.

**Before any push, separately:** the unpushed commits publish operational detail (client names, WABA and phone-number ids, a client phone number, and a statement that the three default seed passwords still worked in production). Confirm rotation covered the demo client, the third seeded default and the 31 leftover test accounts, not only the admin account. See the 2026-10-12 audit in Appendix C.

### 4.2 Nightly `pg_dump`

**This is the single highest-value item in this document.** GV Mart lost 1,738 messages because it did not exist.

Minimum: nightly `pg_dump` to object storage, 14 days retained, **and a restore tested once into a scratch database.** An untested backup is not a backup.

Supabase Pro at $25/month gives 7-day daily backups; PITR is $100/month per 7 days. Note that Supabase backups **exclude Storage API objects**, so media needs its own copy. Decide between paying Supabase and running your own dump — but do one of them this week.

### 4.3 Remaining items

| Item | Note |
|---|---|
| Push the `clients.status` finding | Found, never pushed. |
| Confirm `.claude/` is in `.gitignore` **and committed** | Claude Code session transcripts live under the project directory. This is why rotated passwords must never be printed into a session. **Verified 2026-10-12: in `.gitignore` yes, committed no.** The `.claude/` line (`.gitignore:19`) is an uncommitted working-tree change; `HEAD`'s `.gitignore` only ignores `.claude/scheduled_tasks.lock`. `git ls-files .claude` is empty, so nothing under it is tracked. |
| `clients.status` enforces nothing | A suspended client can still send. Fixed in Phase 0.5. |

### 4.4 Standing constraints — these do not expire

These were established during the investigation and remain in force for every future session.

- **Never print a secret.** Name the variable, the commit and the file. Never the value.
- **Never restore over production.** It would undo the password rotation and two days of every client's messages.
- **Never rewrite git history.**
- **Never delete the Supabase project `fsunrjithwcjtsutsgea`.** It is GV Mart's live backend, referenced in their `.env`, three GitHub workflows, and shipped Android and iOS app assets.
- **Do not re-enable autovacuum** on `messages`/`chats`/`contacts` until the recovery attempt is finished or formally abandoned.
- **Never use session-level settings over `DATABASE_URL`.** The pooler leaks them between sessions. Use `begin read only` or `set local`.
- **Investigations are read-only.** No production writes without explicit approval, named per write.

---

## 5. AI agent — architecture summary

Full specification: `docs/ai-agent/SPEC.md`, as amended at commit `8c1e075` (first committed `7226a637`). **Read it before building. Do not re-derive the design from this section** — this is a summary for orientation, the spec is normative.

The three decisions worth repeating because they shape everything else:

### 5.1 No vector search in Phase 1

Knowledge retrieval is hidden behind one function:

```
get_knowledge_for(agent, message) -> string
# Phase 1: returns agent.knowledge_md, ignores the message.
# Phase 2: may retrieve.
# Nothing else in the pipeline needs to know which it is.
```

`knowledge_tokens` is capped at **2,500 per client**. At that size, sending the whole thing is cheaper and more accurate than retrieving from it, and it removes an entire subsystem from Phase 1. The seam exists so Phase 2 can add retrieval without touching the pipeline.

### 5.2 Gates, not prompts

The agent's safety comes from **eight gates** evaluated in order before any model call and before any send. They are specified in the spec — read the list there rather than from memory. The one worth calling out here, because the first version of it was wrong:

**Gate 4 — human active.** `chats.last_agent_reply_at` is written from exactly two places:

1. the human send path in `server/src/routes/chats.js` (send and retry), and
2. `chatsRepo.insertEcho` (a business replying from its own WhatsApp Business app, which in a Coexistence setup is the main human reply path), **only when the echo is not Wasi's own outbound coming back**: match on the message id and skip the write if an outbound row already exists.

It is **never** written from:
- `flowRunner` / `flowEngine`
- `broadcastRunner`
- the Hub API (`apiV1Messages.js`)
- the agent itself
- `messagingService.sendChatMessage` / `insertOutboundPending` (the shared choke points)

If any of those write it, an automated message makes the agent think a human is in the conversation and the agent goes silent for 15 minutes after every flow message. The first draft of this spec had exactly that bug.

> **Corrected 2026-10-12.** An earlier version of this document excluded `insertEcho`; `SPEC.md` section 7 was right and that exclusion was wrong. **Is the id-match condition load-bearing?** Not on current evidence. Meta's Coexistence documentation lists only the WhatsApp Business app and supported companion devices as triggers for `smb_message_echoes`, and does not list Cloud API sends (inferred from the trigger list; the page does not say so outright). There is no live evidence either way, because the field has never been subscribed (1.1). So treat the condition as defensive, but keep it. `insertEcho` already does `on conflict (meta_message_id) do nothing`, so the write must be gated on that insert having actually inserted a row. One residual race: an echo that arrives before Wasi's outbound row has been given its `meta_message_id` would insert a duplicate row and count as human activity.

### 5.3 Refusal is a first-class output

The model may return `NEEDS_HUMAN`. That is a success, not a failure. It routes the chat to a human and is logged separately from errors. Measure it: a healthy agent refuses often early on, and the refusal rate falling over time is the signal that knowledge is improving.

### 5.4 Cost

Claude Haiku 4.5 at $1 / $5 per million tokens (input / output).

**Prompt caching is not a saving at Wasi's traffic.** Cache writes cost 1.25× and reads 0.1×, with a 5-minute default TTL. On sparse, bursty traffic the write cost is paid repeatedly and the read is rarely hit. Caching loses money here. Revisit only when a single client sustains more than one inbound message per minute during business hours.

`cost_paise` is stored as an **integer**. Never a float. Never a currency type.

---

## 6. Phase 0 — foundations

**Nothing AI-specific ships here. Three of these five items are correctness fixes that earn their keep regardless.**

### 0.1 `chats.last_inbound_at`

Written on every inbound message in `chatsRepo.insertInbound`.

**Why it matters beyond the agent:** you currently cannot determine from the database whether a chat's 24-hour customer service window is open. This is the same gap behind GV Mart losing 55 of 66 sends (Section 2.2). With this column, `session_window_closed` becomes predictable before the send rather than discovered after it.

Backfill from `messages` for existing chats.

### 0.2 `chats.last_agent_reply_at`

Written **only** from the human send path in `routes/chats.js`. See 5.2 for the full exclusion list. Get this wrong and the agent silently never replies.

**Why it matters beyond the agent:** there is currently no record of when a human last replied to a customer, so response-time reporting is impossible.

Backfill is **not** safe — historical messages do not record whether a send was human or automated. Leave existing rows null and let them populate forward.

### 0.3 `flowEngine.evaluate` and `automationEngine.evaluate` return `{handled, how}`

Currently nothing downstream can tell whether a flow matched a message. The agent must not reply to a message a flow already handled, so it needs this. Independently, it is why automation behaviour cannot be audited today.

`how` is a short string naming what handled it, for logging and later analytics.

**Care required:** `metaWebhook.js` calls the flow engine at line 260. Both call sites and all existing callers must handle the new return shape. Confirm there are no other callers before changing the signature.

### 0.4 `ai_jobs` table and an interval-poller runner

A job row per queued agent turn. The runner follows the existing runner pattern (`broadcastRunner`, `forwardRunner`, `flowRunner`, `alertRunner`) — interval poll, claim a row, process, mark terminal.

Requirements: single-claim safety under concurrent runners, bounded retries, a terminal failed state that does not retry forever, and no unbounded queue growth. A job that has been claimed and not completed within a timeout must become reclaimable.

### 0.5 `clients.status` enforcement

Today `clients.status` enforces nothing. A suspended client can still send.

Enforce it at the send path, not the route — there are several routes and one send path. `messagingService.sendChatMessage` and `getSendableWaba` are the right places. A suspended client's send fails with a clear error code; the agent does not run at all.

**Phase 0 definition of done:**
- Both columns exist, are populated going forward, and 0.1 is backfilled.
- A test proves `last_agent_reply_at` is **not** written by a broadcast, a flow, or a Hub API send.
- Both engines return `{handled, how}` and every caller handles it.
- A job can be enqueued, claimed exactly once by one of two concurrent runners, and reaches a terminal state.
- A suspended client cannot send through any path.
- `clients.status` enforcement has a test.

---

## 7. Phase 1 — single-turn reply, shadow mode

The agent runs, produces a reply, and **does not send it.** Replies are stored and reviewed.

**Build:**
1. Agent configuration per client — enabled flag, `knowledge_md`, `knowledge_tokens` (capped 2,500), tone, escalation rules, business hours.
2. `get_knowledge_for` as specified in 5.1 — Phase 1 body returns `agent.knowledge_md`.
3. The model call against Claude Haiku 4.5. No caching (5.4).
4. All eight gates, in spec order, evaluated before the model call and before the send decision.
5. `NEEDS_HUMAN` handling as a success path.
6. Cost logging — `cost_paise` as integer, per turn, attributed to the client.
7. Shadow storage — the drafted reply, the gates that passed, the gate that blocked if any, token counts and cost.

**Why shadow mode:** it produces a real evaluation set from real customer messages with zero risk to a client relationship. Run it for a week on one client before anything sends. The gate-4 bug would have been invisible in testing and obvious in shadow.

**Phase 1 definition of done:**
- 100 real inbound messages have gone through the pipeline with a stored draft or a stored refusal.
- Every gate has fired at least once in shadow, or has a test proving it fires.
- Cost per turn is measured and matches a hand calculation within 5%.
- The refusal rate is known.
- A human has read 50 drafts and judged them send-worthy or not, and that judgement is recorded.

---

## 8. Phase 2 — suggested reply, then live

Two sub-steps. Do not merge them.

**2a — suggested reply.** The draft appears in the Wasi inbox as a one-click suggestion. A human sends it, edits it, or discards it. Record which. This is the last cheap source of evaluation data and it is also a feature worth selling on its own.

**2b — auto-send, one client.** The agent sends when all gates pass. Start with the single client whose shadow results were best. Keep a kill switch per client that takes effect on the next turn, not the next deploy.

**Phase 2 definition of done:**
- Suggestion acceptance rate over 70% unedited, measured over 100 suggestions.
- One client live for 7 days with no customer complaint traceable to the agent.
- The kill switch has been tested in production.
- Section 2.3's alerting covers agent sends too.

---

## 9. Phase 3 — knowledge and handover

- Knowledge ingestion: a client uploads documents, Wasi converts them to markdown and enforces the 2,500-token cap, with clear feedback when their content exceeds it.
- Template-aware replies: when the 24-hour window is closed, the agent proposes an approved template rather than free text. This closes the loop with Section 2.2 — the failure mode becomes a template suggestion instead of a dropped send.
- Handover: an explicit, visible transition to a human with context, and a rule for when the agent resumes.

---

## 10. Phase 4 — productise

- Plan limits and a billing meter built on the `cost_paise` log and the request log from 3.6.
- A client-facing agent builder — knowledge, tone, escalation, hours, without Wasi touching the database.
- Per-client analytics: handled, refused, escalated, cost. **Real data only.** See 3.1.
- Retrieval, **only if** a real client's knowledge genuinely exceeds the cap and trimming it hurts answer quality. The seam from 5.1 is where it goes.

---

## 11. Sequencing

```
BLOCKING   2.1 debug_token  ──┬──> 2.2 GV Mart templates ──> 2.3 alerting
                              ├──> 2.6 Evokz (+ fix 6.x metaClient auth payload)
                              └──> 2.4 tell GV Mart  /  2.5 Supabase decision date

FLOOR      4.2 nightly pg_dump + tested restore     (do this week, in parallel)
           4.1 repo private (deploy key proven first)
           3.1 remove the fabricated chart           (one commit, do it now)
                 [2026-10-12: the commit exists (351d133); what remains is deploying master]

THEN       Phase 0  ──> Phase 1 (shadow, 1 week) ──> Phase 2a ──> Phase 2b
                                                                    │
SMALL FIXES, slotted between phases, never during one:              │
           3.2 language field    3.3 onboarding order               │
           3.4 renumber 081/082  3.6 request log                    │
                                                                    v
AFTER Phase 2                            3.5 GV Mart off demo client
                                         3.7 multi-number (1.5–3 weeks)

LATER      Phase 3 ──> Phase 4
```

**The one rule:** do not run 3.7 (multi-number) or 3.5 (GV Mart migration) concurrently with any AI phase. Both touch the send path. Interleaving them means neither lands and the failure will be hard to attribute.

---

## 12. Prompt for the Claude Code planning session

Paste this into Claude Code in **plan mode** (`claude --permission-mode plan`). It writes no code. Its output is the implementation plan this document cannot produce, because it can read the files.

---

```
Plan mode. Write no code and change no files. Your output is a plan.

CONTEXT
This repository is Wasi, a WhatsApp Business API platform (Meta Tech Provider,
not Solution Partner) serving small Indian businesses. We are about to build an
AI bot reply feature end to end. The specification is already written, already
verified against this codebase, and committed:

    docs/ai-agent/SPEC.md   (as amended at commit 8c1e075; first committed 7226a637)

Read it first and in full. It is normative. Do not redesign it. If you find
something in it that contradicts the code, say so explicitly as a finding —
do not silently plan around it.

TASK
Produce an implementation plan for Phase 0 and Phase 1 as defined in the spec,
at the level of detail where I could hand each step to a separate session and
it would land correctly without asking me anything.

Phase 0 items:
  0.1  chats.last_inbound_at, written in chatsRepo.insertInbound, backfilled
       from messages
  0.2  chats.last_agent_reply_at, written ONLY from the human send path in
       server/src/routes/chats.js. Never from flowRunner/flowEngine,
       broadcastRunner, the Hub API (apiV1Messages.js), the agent itself, or
       chatsRepo.insertEcho. Do not backfill — historical rows cannot
       distinguish human from automated sends.
  0.3  flowEngine.evaluate and automationEngine.evaluate return {handled, how}
  0.4  ai_jobs table plus an interval-poller runner following the existing
       runner pattern (broadcastRunner, forwardRunner, flowRunner, alertRunner)
  0.5  clients.status enforcement at the send path, not the routes

Phase 1 is single-turn shadow mode: the agent drafts a reply and does not send
it. Agent config per client, get_knowledge_for returning agent.knowledge_md,
the Claude Haiku 4.5 call, all eight gates from the spec in spec order,
NEEDS_HUMAN as a success path, cost_paise logged as an integer, and shadow
storage of the draft plus which gates passed or blocked.

BEFORE PLANNING, ESTABLISH GROUND TRUTH AND REPORT IT
Read, do not assume:

  1. Every caller of flowEngine.evaluate and automationEngine.evaluate. I know
     about server/src/routes/metaWebhook.js around line 260. Find the rest.
     Changing the return shape breaks every one.
  2. Every write path into messages and chats. Specifically which paths call
     chatsRepo.insertInbound, insertOutboundPending and insertEcho, so 0.1 and
     0.2 are written in exactly the right places and nowhere else.
  3. The human send path in server/src/routes/chats.js — confirm it is the only
     route a human reply can leave through. If there is a second, name it.
  4. The existing runner pattern. Read one runner end to end and tell me how
     claiming, retrying and terminal states are done today, so ai_jobs matches
     rather than inventing a second pattern.
  5. The highest applied migration number in pgmigrations AND the highest
     numbered file on master. They differ: 081 and 082 are stranded Instagram
     migrations below the highest applied (085). Take the next free numbers at
     implementation time. Do not pre-assign numbers in the plan.
  6. messagingService.sendChatMessage and getSendableWaba — confirm these are
     the right place for 0.5, and that no send path bypasses them.
  7. Whether a test harness exists and what it can actually run. If there is no
     way to test a runner's single-claim behaviour today, say so — that is a
     Phase 0 item.

CONSTRAINTS — these are not negotiable
  - Read-only for this session. No writes, no migrations, no commits.
  - Never print a secret value. Name the variable, the file and the commit.
  - Never rewrite git history.
  - Do not re-enable autovacuum on messages, chats or contacts.
  - Never use session-level settings over DATABASE_URL — the pooler leaks them
    between sessions. Use `begin read only` or `set local`.
  - Do not plan multi-number support or any change to
    wabasRepo.findByClientId. It is a separate 1.5–3 week project and must not
    be interleaved with this.
  - Local dev cannot decrypt production tokens (utils/encryption.js derives the
    key from SERVER_SECRET). That is correct. Do not plan around it.

DELIVER
  1. Ground truth findings from the seven reads above, with file and line
     references. Flag anything that contradicts the spec.
  2. An ordered step list for Phase 0. Per step: files touched, the migration
     (described, unnumbered), the test that proves it, and what breaks if the
     step is wrong.
  3. The same for Phase 1.
  4. Anything in the spec you believe is wrong or unbuildable as written, with
     your reasoning. I would rather hear it now.
  5. Which steps are independent and could run in parallel, and which must be
     strictly ordered.

Do not start implementing. Report the plan and stop.
```

---

## Appendix A — `debug_token` output

*Empty. Fill this in when 2.1 is run. Four client diagnoses depend on it.*

## Appendix B — artifacts and documents

| Document | Location | State |
|---|---|---|
| AI Agent Specification | `docs/ai-agent/SPEC.md` (amended at `8c1e075`; first committed `7226a637`) | Committed, normative |
| Wasi AI Bot — Build and Launch Plan | Claude doc `f1f3ab0e-d42e-4db4-8dea-4e9ba418548e` | Live |
| Wasi Pricing Model | Claude doc `558b65f9-c6d1-4a11-b040-cdcabfa1abaa` | Live, shared with TL and Manager |
| Wasi Plans and Pricing | Claude doc `338248b9-4569-49dd-89c2-64b83d61cd4d` | Live, not on landing page yet |
| Wasi API Reference | Claude doc `514f1794-5289-449f-a8f3-36190499d746` | Written, **not published**. Strip the final internal-notes section first. |
| Wasi Logo Design Brief | Claude doc `441e0f38-b1fa-4918-86a8-b27adf21f8d2` | Live, 40 questions unanswered |

## Appendix C — verification record, 2026-10-12

Result of checking this document's factual claims against the repository (`master`, `37cd0ed`), the production database (read-only) and the live site. Corrections are inline above, marked **Verified** or **UNVERIFIED**.

| # | Claim | Result |
|---|---|---|
| 1 | `wabasRepo.findByClientId` ends `ORDER BY created_at DESC LIMIT 1`; ~30 call sites | Confirmed (line 14/15). 25 direct calls + 1 internal; see 3.7 |
| 2 | `onboarding.js:181` overwrites row, `connecting` before Meta call | Confirmed; also nulls `waba_id`/`phone_number_id` if omitted; see 3.3 |
| 3 | `metaClient.js:677`, singular `language`, comment ~671 | Confirmed; Meta-docs half not re-checked; see 2.6 |
| 4 | `metaWebhook.js` lines 142, ~260, `smb_message_echoes` guard | Confirmed: 142, 260, guard at 575, committed in `cb27227` |
| 5 | No `language` on Hub API payload; newest `created_at`; `en` and `en_US` tie | Confirmed; see 3.2 |
| 6 | GV Mart credentials row, demo `client_id`, used 8 Oct | **UNVERIFIED** (table not in Wasi DB); see 3.5 |
| 7 | Highest applied 085; 081/082 stranded Instagram | Confirmed; branch-only files; see 3.4 |
| 8 | Fabricated chart, "Last 7 days, live from your account." | Confirmed in production, **removed on master** (`351d133`), not deployed; hard-coded; see 3.1 |
| 9 | `SPEC.md` at `7226a637`, 20 sections | Exists there; 20 numbered sections (22 `##` headings); amended since at `8c1e075` |
| 10 | `server/scripts/set-password.js` uncommitted | Confirmed (untracked) |
| 11 | `.claude/` ignored and committed | Ignored yes, **committed no**; see 4.3 |
| 12 | Backups empty, PITR off | Confirmed today |
| 13 | Eight gates, gate 4 = human active | Confirmed; see 5.2 |
| 14 | Eight 409 codes on the API | Confirmed: eight distinct 409 `error.code` values on `POST /api/v1/messages`: `waba_not_connected`, `consent_required`, `plan_limit_reached`, `session_window_closed`, `auth_code_required`, `auth_code_invalid`, `media_resolution_failed` (all via `MessagingError`, any code other than `send_failed`, `apiV1Messages.js:115`), plus `conflict` (a unique-violation, `apiV1ErrorHandler.js:29`). `auth_code_invalid` is also raised directly at `apiV1Messages.js:84`. `not_failed` is chat-retry only, not Hub API |

Not checked in this pass: Meta's current documentation, the live Meta webhook subscription, GV Mart's own Supabase project, and the Render-versus-VPS question (`DEPLOY.md` and `render.yaml` describe Render; section 4.1 above says VPS).

### Follow-up record, 2026-10-12 (second pass)

| Question | Result |
|---|---|
| Is `cb27227` an ancestor of `511ea49`? | No. It is after it. Production has no guard; the subscription is not live, so no echo has been ingested |
| Commits in `511ea49..master` | 24; 4 server files, no migrations, no dependency changes (see 3.0) |
| Why stale | Manual VPS deploy (`deploy.sh`), no auto-deploy, no CI; last run about 1 Oct 14:32 IST |
| How the deploy reaches GitHub | Not determinable from the repo; VPS remote config needed (4.1) |
| Unpushed commits `9a97664`, `4235a24`, `f55a97c`, `37cd0ed`, `65c5a2c` | No tokens, keys or live secrets. They publish client names, WABA and phone-number ids, a client phone number, client UUIDs, a local dev DB password in a snippet, and the default seed credentials with a statement that they still worked in production. All in `docs/HANDOVER-2026-10-03.md` except `65c5a2c`'s ids and UUIDs in this file |
| `.claude/` tracked? | No. Only `scheduled_tasks.lock` was ever committed, untracked in `a988716`. Committing just the 3-line `.gitignore` change is safe |
