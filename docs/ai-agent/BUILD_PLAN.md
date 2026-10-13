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

**Standing rule: no figure enters this document without its source named** (a query, a file and line, a commit, a log, or a named person's statement). A figure with no source is recorded as unknown. Three figures this document once carried turned out to be artifacts; the history is in Appendix D.

---

## 1. Current state

### 1.1 What exists and is correct

| Thing | State |
|---|---|
| `docs/ai-agent/SPEC.md` | **Current version is as amended at `8c1e075`** (decision 14, sections 10.5/13/20); first committed at `7226a637` (full SHA `7226a6370d9f…`). Cite `8c1e075`, not `7226a637`, for the current text. 20 numbered sections (1–20; the file also has a section 0 and a closing sequencing note, 22 `##` headings in all). Verified against the codebase — the `users(id)` error, the migration-number error and the gate-4 logic error were all corrected before commit. **This is the source of truth for the AI feature. Read it, do not re-derive it.** |
| Admin credential rotation | Done twice. `token_version` bumped to 2. No secrets are reachable through admin routes, so client WABA tokens did **not** need rotating. |
| `server/scripts/set-password.js` | Written. Hidden prompt, 14-character minimum, bumps `token_version`, writes an audit row, never logs the value. **Uncommitted.** |
| Echo ingestion | **Not fixed; corrected 2026-10-12.** The code path exists (`907b71d`), but the app is still **not subscribed** to `smb_message_echoes`: a live `GET /{app-id}/subscriptions` returned `messages, account_update, message_template_status_update, phone_number_name_update, message_template_quality_update, phone_number_quality_update` and nothing else. No echo has ever been delivered (zero echo rows in `audit_log`, zero `messages.source='whatsapp_app'`). Subscribing is a human dashboard action, and per 3.0 it must not happen before production runs `cb27227`. **VPS note, 2026-10-12:** two numbers checked there (TNPSC and the demo) report `platform_type CLOUD_API` and `is_on_biz_app` false. That does **not** generalise: the stored `wabas.registration_is_on_biz_app` is **true for 7 of the 10 connected WABAs** (false: TNPSC, demo; unknown: Sirah). The echo thread is therefore **not** de-prioritised on current evidence; see Appendix A. *(Verification note 2026-10-12: the dashboard subscription state and the echo payload shape were not re-checked in this pass. `SPEC.md` decision 14 still lists the payload shape as not confirmed against a live capture.)* |
| `metaWebhook.js` field guard | Fixed. `field !== 'smb_message_echoes'` now prevents echoes being processed as inbound messages. **Verified 2026-10-12:** guard present at `server/src/routes/metaWebhook.js:575`, committed in `cb27227`; the file has no uncommitted changes. **Not in production:** `cb27227` (3 Oct) is after `511ea49` (1 Oct), so the deployed server has no guard; see 3.0. |
| TNPSC diagnosis | **Corrected 2026-10-12.** The earlier claim (stored WABA `894384560175844` is the wrong one; Meta says `1649658386105751` owns the phone) is **withdrawn**: `diagnostic_scope_check.js` on the VPS reports "stored phone_number_id `1222704867593433` belongs to this WABA" and Meta returns that number as `TNPSC Mentors`, `CLOUD_API`, quality GREEN, status CONNECTED (source: VPS diagnostic session reported by the project owner, 2026-10-12). The stored WABA/phone pairing is right. The real problem is **scope targeting**: the token's `whatsapp_business_management` granular scope now targets only `1649658386105751`, not the stored WABA, so reads succeed and writes fail (`#200`). See Appendix A. **Still open:** what `1649658386105751` is (see 2.1). **TNPSC appears to have several WABAs** (`894384560175844` stored and working; `1649658386105751`; and `998094716164113`, "Tnpsc Mentors" ending 9808, which sits on the `Sirah` client's row, see 3.15). We do not know which they intend to use: a question for the client, not a database fix. |
| Encryption | `server/src/utils/encryption.js` — AES-256-GCM, key derived from `SERVER_SECRET`. Local development cannot decrypt production tokens. **This is correct behaviour and must not be "fixed".** |

### 1.2 What does not exist

- **No AI feature code at all.** No migration, no model call, no `ai_jobs` table, no agent configuration, nothing. Phase 0 has not started.
- **No database backups.** `"backups": []`, `pitr_enabled: false` on the Wasi Supabase project (`exvoupxpocybjcxmkuac`). A restorable backup is what would have made the 7 Oct client deletion (2.4) reversible; none exists. *(Re-verified 2026-10-12 via the Supabase Management API, `GET /v1/projects/exvoupxpocybjcxmkuac/database/backups`: `backups: []`, `pitr_enabled: false`, `walg_enabled: true`.)*
- **No API request log.** When a client asks "did my call reach you?", there is no way to answer.
- **No send-failure alerting.** Wasi has no rule that notices a client's sends failing unless someone looks (see 2.3). The earlier "55 of 66 GV Mart sends" example was **not** a Wasi failure rate; see 2.2 and Appendix D.
- **No multi-number support.** `wabasRepo.findByClientId` returns the newest WABA only.

### 1.3 The thing that keeps happening

Every attempt to start the AI feature has been interrupted by a production problem that was more urgent. That is not bad luck — it is a signal that Wasi has no operational floor. There is no backup, no request log, no failure alerting, and no enforcement on `clients.status`. Until those exist, any feature built on top will keep being interrupted by the floor giving way.

Phase 0 of the AI feature happens to build three of the four missing floor pieces. That is the argument for doing it, independent of whether the bot ever ships.

---

## 2. Blocking work — nothing else starts until this is clear

These are live, they affect paying clients, and three of them are getting worse by the day.

### 2.1 Run the `debug_token` script

**Status:** the script was written 9 October and **run on 2026-10-12 on the VPS for three WABAs** (demo, TNPSC, GV Mart), the only machine that can decrypt WABA tokens. The other seven connected WABAs have **not** been run (see Appendix A). Results are in Appendix A.

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

> **Result, 2026-10-12 (source: VPS diagnostic session reported by the project owner, 2026-10-12): three causes, not one.**
> - **TNPSC (`#200`):** scopes present, but `granular_scopes` `target_ids` = `["1649658386105751"]`, which is not the stored WABA. Reads work, writes do not.
> - **GV Mart (`#100`, subcode 33):** the token's scopes are `public_profile` only: no `whatsapp_business_management`, no `whatsapp_business_messaging`, no granular scopes. Every call is HTTP 400. This also explains the `sendability_registration_check_failed` rows (my count from `audit_log`, 2026-10-12: 123 on GV Mart's current client, 47 on its deleted predecessor, 573 on `Sirah`, 744 in total; the VPS session's figure of 241 was not reproduced).
> - **Demo (`983390651411856`):** both scopes, granted to all targets, all three calls HTTP 200. Healthy.
> - **Sirah Digital's own WABA (`351363664731426`) is healthy**: both scopes, all three calls HTTP 200 (source: VPS diagnostic session reported by the project owner, 2026-10-12). The `#100` this document attributed to "Sirah Digital" is the separate **`Sirah` client's** stored WABA (`998094716164113`), which returns code 100 subcode 33; see 3.15. That attribution is my inference from the matching error code, not something the script printed. **Evokz is still not diagnosed:** run it before concluding.
> - All tokens checked are `SYSTEM_USER` tokens under the same app (`Sirah CRM Wp`, app id `27135450269410430`). **The system user is per business portfolio, not per client**: `Sirah` and `Sirah Digital` share user id `122106946323459883` (same business), while demo, TNPSC and GV Mart have different ids. Working hypothesis, not established: the WhatsApp permissions were granted inconsistently at onboarding. GV Mart's `public_profile`-only token matches the `not_authorized` failure already documented for Embedded Signup (the app was never authorised for WhatsApp).
> - **Open question on `1649658386105751`:** the VPS session guessed it is "probably their business portfolio id". In-repo evidence points the other way: at connect time (17 Sep) our own discovery recorded `wabaTargetIds = [1649658386105751, 894384560175844]` in `wabas.connect_diagnostics`, and `granular_scopes` `target_ids` for `whatsapp_business_management` are WABA ids; and 8 `messages` webhooks keyed by `1649658386105751` arrived 24 Sep to 8 Oct (`audit_log`), and Meta keys a webhook entry by WABA id. The decisive check is one call on the VPS with TNPSC's token: `GET /1649658386105751?fields=name` and `/phone_numbers`.

### 2.2 GV Mart sends — closed; not a Wasi failure (corrected 2026-10-12)

**Status:** closed. No action for Wasi.

This item used to read "55 of GV Mart's 66 outbound messages failed with `session_window_closed` in 48 hours". That was **not a Wasi failure rate.** It was GV Mart's own test burst on 8 Oct, sent to two of GV Mart's own test numbers, which GV Mart diagnosed and fixed themselves. **Source:** GV Mart's own account, relayed by the project owner on 2026-10-12. The 66 rows were counted in GV Mart's own Supabase outbox (`fsunrjithwcjtsutsgea`, per the recovery-record note in 2.4), not in Wasi's database, and Wasi's database holds no outbound messages for GV Mart's current client (queried 2026-10-12: `messages` count for client `4b09813e…` is 0).

The platform rule itself stands, as a general fact and not as a GV Mart finding: free text outside the 24-hour customer service window is rejected (`session_window_closed`); only an approved template can be sent.

### 2.3 Send-failure alerting

**Status:** not built. `alertRunner` already exists and is the right place for it.

Nothing in Wasi notices a client's sends failing unless someone looks. Build the alert so the next one finds itself.

**Minimum viable rule:** for each client, over a rolling 6-hour window, if `failed_sends / total_sends > 0.3` and `total_sends >= 10`, raise an alert. Separate the alert by failure reason, because `session_window_closed` is a client-behaviour problem and `waba_not_connected` is a Wasi problem, and they need different responses.

**Definition of done:** the rule fires on a synthetic test.

### 2.4 GV Mart's deleted client — what is established (closed 2026-10-12)

**Status:** closed. The deletion was intentional, per the project owner (2026-10-12), and the cascade did what it was designed to do. Nothing broke.

**The number of deleted messages is UNKNOWN.** The "1,738 messages" this item used to carry was a count of surviving `audit_log` webhook rows for the old WABA, mixing inbound messages and status callbacks. See Appendix D.

**What is established, with sources:**

- **What was deleted:** client `e186eb60-98e5-4642-a9f9-3ca491347792`, via `DELETE /api/clients/:id`, which writes no audit row.
- **Deletion window: 7 Oct 2026, 07:04:47 to 07:08:31 UTC.**
  - *Lower bound, 07:04:47.424Z:* `audit_log` `client_password_reset` for that client, so the row still existed.
  - *Upper bound, 07:08:31.283Z:* `pg_stat_user_tables.last_autovacuum` for `contacts`. An autovacuum triggered by those deletes cannot finish before them.
  - *Independent corroboration:* the replacement client (`4b09813e…`) was created at 07:09:54.980Z (`clients.created_at`, and the `api_key_created` audit row) with the **same email**; `clients.email` is unique (`clients_email_key`), so the old row was already gone.
- **Cascade chain** (from `pg_constraint`, all `ON DELETE CASCADE`): `clients` → `messages` (`messages.client_id`); `clients` → `chats` → `messages` (`messages.chat_id`, plus `chat_notes` and `chat_sla_logs`); `clients` → `contacts` → `consent_events`, `contact_attribute_values`, `contact_tags`, `flow_events`; and by `client_id`: `api_keys`, `wabas`, `webhook_deliveries`, `message_templates`, flows/nodes/edges, `tags`, `broadcasts`, `usage_logs`, `subscriptions`, `invoices` and others. `chats.contact_id` is `SET NULL`; `payment_notifications.client_id` is `SET NULL`.
- **The old WABA had been failing since 5 Oct.** `audit_log` shows `sendability_registration_check_failed` ("Unsupported get request", 47 rows) from 2026-10-05T09:02:39Z through 2026-10-07T07:02:33Z. The last webhook for WABA `109558648723856` was 2026-10-04T17:47:02Z. That WABA id is *inferred* to be e186eb60's (its first webhook, 26 Aug 11:31:22Z, came 2m28s after that client's `whatsapp_connected` at 11:28:54Z); no surviving row states it directly.
- **Current WABA is a different id** (`1766605231203643`). Whether it is the same phone number is not recorded anywhere that survives.

**Recovery is closed by decision, not by exhaustion.** `pageinspect` on `messages` might have shown surviving dead tuples (last vacuum 3 Oct, so the 7 Oct deletes may still have been on disk). The owner declined (2026-10-12) because the best possible result was message bodies and timestamps with no chat or customer identity: chats were vacuumed 9 Oct 05:37:32Z and contacts 7 Oct 07:08:31Z. That is not a history that could be given back to GV Mart. The dead tuples were therefore never examined.

**Who issued the delete:** not recorded. The route requires an admin token but there is no session store or login audit. The 07:04:47 reset, the delete, and the 07:09:54 re-creation were all the one shared admin identity within about five minutes, which fits a deliberate recreate. Source IP: pending the nginx log review.

### 2.5 Supabase support ticket — moot; autovacuum restored (2026-10-12)

**Status:** closed. The ticket is moot (nothing broke; see 2.4) and is to be withdrawn by the project owner.

**Autovacuum was re-enabled on `messages`, `chats` and `contacts` on 2026-10-12** by resetting the `autovacuum_enabled` storage parameter (`alter table … reset (autovacuum_enabled)`), restoring the table default. Confirmed live: `pg_class.reloptions` is null on all three. Dead tuples at that moment (`pg_stat_user_tables`): `chats` 628, `contacts` 6, `messages` 1,328. Table sizes with indexes were 952 kB, 808 kB and 4,016 kB, so the vacuum is trivial IO.

### 2.6 Evokz

**Status:** needs a message sent.

Ask Evokz to complete business verification and add a payment method. Note that per 2.1 neither of these is the confirmed cause of their template failure — they are prerequisites for sending at scale regardless, and asking for them is useful on its own. The authentication template stays blocked until 2.1 explains the real cause.

**Known complication:** `buildAuthenticationPayload` at `server/src/utils/metaClient.js:677` posts to `/{waba}/message_templates` with a singular `language` field. Meta documents authentication templates via `POST /<WABA_ID>/upsert_message_templates` with a `languages` **array**. The comment at line 671 admits the shape is not confirmed against live Meta. **This code has never successfully run against Meta.** Expect it to be wrong, and fix it as part of the Evokz work rather than treating a failure as a permissions problem.

> **Updated 2026-10-12.** Authentication templates **do** work at Meta: TNPSC has `signup_otp2`, `APPROVED`, category `AUTHENTICATION` (source: VPS diagnostic session reported by the project owner, 2026-10-12; consistent with its NULL `auth_options`, i.e. created outside this code). So Evokz is not blocked by the template category, and not necessarily by `buildAuthenticationPayload`. The most likely cause is the token's scopes, as for GV Mart. **Evokz's WABA has not been run through `diagnostic_scope_check.js` yet**, so this is a hypothesis; run it before changing any code.

> **Verified 2026-10-12.** Confirmed in code: `buildAuthenticationPayload` is at `metaClient.js:677` and emits a singular `language` (default `'en_US'`); it only *builds* the payload, which `createMessageTemplate` then posts to `/{wabaId}/message_templates`. The "not doc-confirmed live" comment is at lines 668–676 (the admission is on 671). **Not verified here:** Meta's documentation for `upsert_message_templates` / `languages` was not re-read in this pass. **Evidence for "never run":** production has two approved Authentication templates (`signup_otp2`, TNPSC mentors, 17 Sep; `test_message`, Sirah Digital, 21 Sep), but both have `auth_options` NULL, which this app's create path persists. That is consistent with both having been created outside this code and synced in. It is an inference from the data, not proof (a created-then-deleted template would leave no row).

> **Added 2026-10-12 — where those two templates came from.** `messageTemplatesRepo.create` (`messageTemplatesRepo.js:58-82`) always writes a non-null `auth_options` object for an Authentication template, whichever route called it (`POST /api/templates` or the Hub API). Template sync's insert path (`templateSyncService.js`, the `toInsert` branch) does not write `auth_options`, and its update branch never touches it. A NULL `auth_options` with a `meta_template_id` therefore means the row was **synced in from Meta, i.e. the template was created directly in Meta (WhatsApp Manager or Graph API), not through Wasi's code.** Both also carry language `en`, not Wasi's `en_US` default, which is consistent. **Immediate route for Evokz that does not depend on fixing `buildAuthenticationPayload`:** have the template created in WhatsApp Manager on Evokz's WABA, then run template sync. **Caveat, untested:** Evokz's error is a WABA-level permission refusal; if it is enforced by Meta on the WABA rather than on the API, WhatsApp Manager may refuse too. 2.1's `debug_token` output decides that.

### 2.7 GV Mart Embedded Signup, Meta error 3441047 ("not available for accounts using marketing messages") — MM Lite check (read-only, 2026-10-13)

**Status:** investigated; **the app's own config does not enable MM Lite, and the question of when GV Mart's WABA was enrolled cannot be answered from our data.** No writes were made to the database, nothing pushed or deployed. Queries ran in `begin read only` transactions against the shared database.

**Q1. Does our Embedded Signup enable MM Lite? Not from our code.**

- The only place the signup config is built is `embeddedSignup.js:358-402` (`FB.login(..., options)`). The options object is `{ config_id: configId, response_type: 'code', override_default_response_type: true, auth_type: 'reauthenticate', extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding' } }` (`embeddedSignup.js:359-401`; `extras` is on line 401).
- There is **no `extras.features` array**, no `marketing_messages_lite`, and no multi-product / "products" key. `featureType: 'whatsapp_business_app_onboarding'` is the Coexistence sub-flow, which is what GV Mart's error says is incompatible with MM Lite.
- `configId` comes from `process.env.META_CONFIG_ID` (`server/src/routes/onboarding.js:31`) and is passed through unchanged (`app.js:7339`, `marketing/signup.js:403`). A grep of the repository's `*.js`/`*.html` for `marketing_messages`, `MM Lite`, `AD_ACCOUNT_LINKED` and `features:` finds nothing relevant (the only `features:` hits are pricing-plan copy in `marketing/plans.js`).
- **What this does NOT rule out:** a Facebook Login for Business configuration stores its own product/feature list on Meta's side, keyed by `META_CONFIG_ID`. If that configuration were set up with a marketing-messages product, it would apply to every client without appearing anywhere in our code. That is checkable only in the App Dashboard (Facebook Login for Business > Configurations > the config's selected products/features). **Action for the project owner: open the config and confirm no marketing-messages product is ticked.**
- **Evidence it is probably not the config:** 7 of 9 `wabas` rows have `registration_is_on_biz_app = true` (see Q3), including WABAs onboarded on 9, 19 and 21 Sep, i.e. the same config produced successful Coexistence connections, and GV Mart's own previous WABA itself reported `is_on_biz_app=true` (below). A config that enrolled every client in MM Lite would have blocked those. The conclusion is that enrolment is specific to GV Mart's Meta business, not caused by Wasi.

**Q2. When was GV Mart's WABA enrolled? Not determinable from our data. Reasons, and what the data does bound.**

1. **We do not store the event type.** `metaWebhook.js:442-443` — `handleAccountUpdate` returns `false` immediately when `value.phone_number` is absent, before the audit write at `:472-477` (the only place the payload is recorded, truncated to 500 chars). An MM Lite onboarding event (`AD_ACCOUNT_LINKED`) has an `event` field and WABA info, not a `phone_number`, so it takes that early-return path. The only trace is the generic per-field row at `:642-647` (`action = 'account_update'`, `target = entry.id`), which has **no payload**. `meta_webhook_log` stores only `success`, `duration_ms`, `entries_processed`, `waba_ids_touched` and `error_summary`, so it carries no payload either.
2. **Search results (queries 7 Oct; `audit_log`, retained since 2026-08-11):**
   - `audit_log` rows whose `target` mentions `AD_ACCOUNT`, `marketing_messages`, `mm_lite` or `3441047`: **0**.
   - `account_update` rows for WABA `1766605231203643`: **0**. For WABA `109558648723856`: **0**. Their only webhook rows are `messages`: 1,738 for `109558648723856` (26 Aug 11:31:22Z to 4 Oct 17:47:02Z) and **1** for `1766605231203643` (7 Oct 08:22:45.724Z).
   - Every `account_update` row (139 total, 20 Aug to 7 Oct) has a bare entry id as `target`; 106 are under `1206549993706435`, which matches **no** `wabas.waba_id` (current or the two asked about); 1 under `463815720015046` (28 Sep); 32 are `test_suite_messagingtier_waba_id` test rows. **Inference, not proven:** `1206549993706435` is not a client WABA; its rows cluster in the minutes before each `whatsapp_connected`/`wabas` insert (e.g. 17 Sep 07:57:35Z to 07:58:34Z before the 07:58:43Z row; 7 Oct 07:28Z to 07:50Z before the 07:50:41Z connect), which fits an app/business-level entry id that Meta uses for onboarding events. Since no payload was kept, this cannot be confirmed.
3. **Timeline for GV Mart, with sources (all `audit_log`, UTC):**

   | When | Event | Source |
   |---|---|---|
   | 2026-08-26 11:28:54 | old client e186eb60 `whatsapp_connected` | CLAUDE.md / section 2.4 |
   | 2026-10-04 17:47:02 | last webhook for old WABA `109558648723856` | `audit_log` |
   | 2026-10-05 09:02 to 10-07 07:02 | old client's registration check failing (47 rows) | section 2.4 |
   | 2026-10-07 07:04:47 to 07:08:31 | old client deleted | section 2.4 |
   | 2026-10-07 07:09:54 | new client `4b09813e` created (same email) | `audit_log` `api_key_created` 07:09:55 |
   | 2026-10-07 07:28:48 to 07:50:18 | 7 `account_update` bare rows under entry `1206549993706435` | `audit_log` |
   | 2026-10-07 07:50:41 | `whatsapp_connected` for `4b09813e` | `audit_log` |
   | 2026-10-07 08:02:32 | **registration check: `is_on_biz_app=true`, `platform_type=CLOUD_API`**; verdict `sendable=false`, "WABA is BLOCKED (#141006) — error with the payment method" | `audit_log` `sendability_registration_checked`, `sendable_verdict_computed` |
   | 2026-10-07 08:22:45 | the single webhook for WABA `1766605231203643` | `audit_log` |
   | 2026-10-07 08:54:07 | last 2 `account_update` rows (post-connect) | `audit_log` |
   | 2026-10-07 13:02:31 onward, hourly | registration check fails: "Object with ID `1379147205282259` does not exist" (138 times, last 13 Oct 06:02:31) | `audit_log` |
   | 2026-10-13 06:59:35 | a third GV Mart client `a84e3c27` created, status `pending_setup` | `clients`, `audit_log` |

4. **What this bounds.** The 7 Oct connection (`4b09813e`) **did complete Coexistence** (`is_on_biz_app=true`), which is not possible for a WABA already on MM Lite at that moment. So on this evidence the enrolment happened **after 7 Oct 07:50:41Z, not during the recreation window**: either in the six hours before the registration check began failing (08:02 to 13:02Z), or later. The `#141006` payment-method block at 08:02:33Z is a separate billing state on the same WABA and is the nearest recorded sign of a Meta-side account change in that window. This is an inference from "Coexistence completed once"; it is **not** a recorded enrolment time, and a 08:54:07Z `account_update` pair is the only post-connect event we hold for that entry.
5. **Caveat on identity.** GV Mart's current `a84e3c27` has no `wabas` row, so which WABA the failing 3441047 attempt is against was not read from our DB; `1766605231203643` is taken from the request. `4b09813e` and its `wabas` row no longer exist (its probes ran through 13 Oct 06:02Z, then it was deleted before `a84e3c27` was created at 06:59Z). Section 2.4's "replacement client `4b09813e`" is therefore itself superseded. That second deletion is **unaudited**, like the first (`DELETE /api/clients/:id` writes no audit row, see 3.8).
6. **How to get the real answer (needs Meta, not our DB).** Business Settings > WhatsApp Accounts > GV Mart's WABA > Marketing Messages, or `GET /{waba-id}?fields=marketing_messages_lite_api_status` / the equivalent in the MM Lite docs (field name **not verified here**; check the current Meta docs before using it). Meta's webhook delivery log in the App Dashboard may also still hold the `account_update` payload for 7 Oct.

**Q3. The other nine WABAs.**

`wabas` has 9 rows (not 10; `wabas` does not contain GV Mart's current WABA at all):

| `waba_id` | status | `registration_is_on_biz_app` |
|---|---|---|
| 983390651411856 (Wasi Demo) | connected | **false** |
| 392608088696144 | connected | true |
| 998094716164113 | failed | null |
| 918537580543018 | connected | true |
| 1319892496787906 | connected | true |
| 463815720015046 | connected | true |
| 894384560175844 | connected | **false** |
| 557382370790751 | connected | true |
| 351363664731426 | connected | true |

- **7 `true`, 2 `false`, 1 `null`** (the `failed` row). That matches "7 completed Coexistence".
- **No WABA shows an MM Lite signal in our data. This is an absence of recording, not confirmation:** the event would not have been stored (Q2.1). The single `account_update` row under a client WABA id is `463815720015046` on 28 Sep 11:25:41Z, bare, so its type is unknown. For those 7 the stronger evidence is the Coexistence completion itself, which Meta says is blocked for an MM Lite account, **but only at the time of onboarding**: it says nothing about a WABA enrolled afterwards. That is the GV Mart pattern (Q2.4), so these 7 could be enrolled later without our knowing.
- The two `false` rows (Wasi Demo, `894384560175844`) are not Coexistence at all, so MM Lite is not excluded for them by that argument.

**Recommended follow-ups (none done):**

1. **Persist `account_update` payloads for events without `phone_number`.** Move the audit write in `handleAccountUpdate` ahead of the `phone_number` early return, or add an `else` branch recording `value.event` and the waba id. Without it this question is unanswerable next time. It is a few lines, and the payload contains no customer data. Mind `audit_log.target`'s 500-char truncation convention and CLAUDE.md's webhook-contract rule for `enqueueForwards` (do not forward it unintentionally).
2. Confirm in the App Dashboard what products `META_CONFIG_ID` carries (Q1).
3. Ask GV Mart (or read in their Meta Business Manager) whether they enabled "Marketing Messages Lite" or accepted its prompt; the error says they did, or that someone did on their behalf. Opting out of MM Lite on their side is the only fix; nothing in Wasi can do it.
4. Do not re-run Embedded Signup for GV Mart until (3) is done: each failed attempt is another unaudited `wabas` row to clean up.

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

**VPS facts verified 2026-10-12** (source: VPS diagnostic session reported by the project owner, 2026-10-12, from `/opt/wasi`, the compose `working_dir`, confirmed with `docker inspect`):
- **The checkout itself is stale, not just the image.** `git log -1` is `511ea49e93c6…` (1 Oct 14:27 +0530, "UI redesign stage 4: Chat view"). Nobody has pulled since 1 Oct. The container `wasi-crm` runs `wasi-crm-server:latest`, created 2026-10-01 09:02:19 UTC.
- **`origin` is `https://github.com/Jesheeba/Wasi.git` (HTTPS) with no credential helper.** Flipping the repo to private **will** break the deploy. See 4.1.
- **The checkout is dirty:** `git status` shows ` M deploy.sh` and 20 untracked files (3.10, 3.11). A pull may clobber `deploy.sh`.
- **The host has no `server/node_modules`.** Dependencies exist only inside the image, so any script needing `pg` must run as `docker exec wasi-crm node /app/server/<script>`. This is why nothing could be run from the host.
- `server/.env.production` exists (657 bytes). It was mode 644 and was set to 600 in that session.

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
>
> **At Meta (2026-10-12; source: VPS diagnostic session reported by the project owner, 2026-10-12):** both are `APPROVED`, category `UTILITY`, as template ids `1435455455108429` and `1437829231531979`. Both exist upstream, so the tie is real and `language` really is the only discriminator.

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
- **[Superseded 2026-10-12 by owner decision: Phase 0.5 no longer waits on this. It blocks `suspended` only, and 0 clients are suspended, so it cannot cut anyone off. GV Mart's move is gated on the token fix (2.1), not on 0.5.] The original text follows, and applies to any design that blocks non-`active` clients: Phase 0.5 (`clients.status` enforcement) MUST NOT ship before GV Mart is on a real, `active` client row.** Today GV Mart's own client is `pending_setup`; enforcement that blocks non-`active` clients would cut off their own row the moment any traffic is attributed to it (their own key or WABA). It is also a wider issue: of the 14 non-test clients, 8 are `pending_setup` (5 of them with a connected WABA, none having sent in the last 14 days) and 6 are `active` (4 sent in that window, the demo client among them). Enforcement would block those 5 connected `pending_setup` clients as soon as they send. Fix the status values first, then enforce.
- **Fix:** create or activate a proper client row for GV Mart, migrate their credentials, chats, messages and templates onto it, verify their sends still work, then remove the demo forward.
- **Risk:** this touches a live client's message history. Do it as a transaction with a verified rollback, during a quiet window, and prove the row counts match before and after.

**Dependency, added 2026-10-12:** GV Mart's own WABA token has only `public_profile` (2.1, Appendix A), so it **cannot send or read anything today**. Moving GV Mart onto their own client row does not work until that token is replaced with one carrying the WhatsApp scopes (a clean re-onboarding). Fix 2.1 first.

### 3.6 No API request log

Build one. Minimum: timestamp, client id, route, status code, error code, latency, and a truncated request id — **not** the payload, which contains customer phone numbers and message bodies. Retention 30 days.

This exists so that "did my call arrive?" has an answer. It is also the only way to charge for API usage honestly later.

### 3.7 Multi-number is not supported

`wabasRepo.findByClientId` at `server/src/repositories/wabasRepo.js:14` ends in `ORDER BY created_at DESC LIMIT 1`. There are roughly 30 call sites that assume one WABA per client.

> **Verified 2026-10-12.** Line 14 is the function declaration; the `order by created_at desc limit 1` SQL is line 15. Count of `wabasRepo.findByClientId` call sites in `server/src`: **25 direct calls in 10 files** (`admin.js` 9, `onboarding.js` 4, `templates.js` 4, `clientNotifier.js` 2, and one each in `apiV1Account.js`, `apiV1Templates.js`, `broadcasts.js`, `templateLibrary.js`, `messagingService.js`, `templateSyncService.js`) plus one internal call inside `upsertForClient`, which itself has 8 callers (`admin.js` 4, `onboarding.js` 4). So "roughly 30" holds (25, or 33 counting `upsertForClient`'s callers). A further 28 lines in `server/test` reference it. The shared send choke point is `messagingService.getSendableWaba` (`messagingService.js:35`); `broadcastRunner.js` and the flow runners do not call it directly.

The correct model is **phone numbers as their own table under a WABA** — a WABA can hold several numbers, and the client picks per send. Estimated 1.5–3 weeks.

**Do not start this during the AI build.** It touches 30 call sites including every send path, and interleaving it with the AI feature means neither lands. Schedule it after Phase 2.

### 3.8 `DELETE /api/clients/:id` is unaudited, unconfirmed and ungated

**Spec only; nothing built. Decisions below were made by the project owner on 2026-10-12.**

**Today** (source: `server/src/routes/clients.js`, `DELETE /:id`): `requireAdminAuth()` only; no body, no audit row, no role check (`adminRole` is never read anywhere), and every one of about 38 `client_id` foreign keys cascades. At least three real clients (`a6959183…`, `792a86cf…`, `e186eb60…`) were deleted this way with no record of who did it.

**Ordering: backups outrank this route.** 4.2 (nightly `pg_dump` with a **tested** restore) comes first. With backups a wrong delete is recoverable; without them no amount of route hardening helps. Per-person admin accounts and the admin login audit (3.9) come before the role gate, because they are smaller and worth more.

**Decision: hard delete stays; soft delete is rejected.** The reasons are the trade-offs, not a preference:

| | Hardened hard delete (chosen) | Soft delete (rejected) |
|---|---|---|
| Reversible | Only through backups (4.2) | Yes, until purge |
| Surface changed | One route | Every query, RLS policy, the background runners, webhook lookup by WABA id, API-key auth, login, team login |
| Failure mode | Wrong client deleted | A missed code path leaves a "deleted" tenant still sending or receiving |
| Unique constraints | None | `clients.email` and `tenant_slug` stay taken, which **blocks re-creating a client with the same email: exactly the GV Mart case that caused this review** (partial index or tombstoning needed) |
| Erasure / retention | Data is really gone | Personal data retained; a purge job is needed anyway |
| Meta side | WABA row gone | WABA stays subscribed unless explicitly unsubscribed |

**Spec of the fix:**
1. **Role gate:** shared middleware, `super_admin` only, applied to this route. (With a single admin account this constrains nobody until 3.9 lands, which is why 3.9 is first.)
2. **Confirmation, in the body:** `{ "confirm_name": "<exact client name>", "reason": "<required free text>" }`. **When `confirm_name` is absent or wrong, respond `409` with the dependent-row counts** (messages, chats, contacts, templates, active API keys, WABAs incl. WABA id and phone-number id, flows) and refuse. A bare `DELETE` therefore tells the operator "this removes N messages, N chats, N contacts, 1 WABA" and does nothing. No nonce store is needed.
3. **Audit, same transaction, before the delete:** insert the `audit_log` row, then delete; if either fails both roll back. The row records: client id, name, email, status, tenant slug, WABA id and phone-number id, the counts above, the acting admin id and role, source IP, user-agent, and the `reason`. `audit_log` has no foreign key to `clients`, so it survives the cascade. It has no detail column today, so this needs a nullable `detail jsonb` column (a migration).
4. **Consent evidence is archived before deletion** (decision: yes; opt-in evidence is a compliance artifact that should outlive the tenant). Spec: a new platform-internal table, e.g. `deleted_client_consent_archive`, with **no foreign key to `clients`** (same treatment as `audit_log` and `alert_events`, and no `wasi_app` grant). Populated by `INSERT … SELECT` in the same transaction, one row per `consent_events` row, carrying the event fields (type, evidence, `actor_type`/`actor_id`/`batch_id`, `created_at`) plus a snapshot of the client id and name and the contact's id and phone. **Open:** that table retains personal data after a tenant is deleted, so a retention period and legal basis must be decided; this is an owner/legal call, not an engineering one.
5. **Hold:** the suspend-first rule (delete allowed only for clients suspended for N days) waits until Phase 0.5 (`clients.status` enforcement) exists.

---

### 3.9 Per-person admin accounts and the admin login audit (do before 3.8's role gate)

**Why:** every unattributable finding of this investigation (the exposure verdict, the three deleted clients, the 19 Aug support admin) traces to **one shared admin identity with no login audit**. This is smaller than 3.8 and worth more.

**Spec:** (1) create one admin account per person (`POST /api/admin/admin-users` already exists), then stop using the shared account. (2) Deploy the admin login audit already written in the uncommitted `server/src/routes/adminAuth.js` (records `admin_login_succeeded` / `admin_login_failed` with `req.ip`) and commit it with `server/test/adminLoginAudit.test.js`. (3) Add per-action IP capture for admin writes (today only `admin_user_created` records an IP). Enforcing `adminRole` on the write routes is the follow-on.

### 3.10 Twenty untracked diagnostic scripts on the production host

**Facts** (source: VPS diagnostic session reported by the project owner, 2026-10-12): `/opt/wasi` contains 20 untracked `.js` scripts written directly on production: `diagnostic_scope_check.js`, `diagnostic_auth_template_retry.js`, `permission_probe.js`, `token_transport.js`, `registration_sweep.js`, `fortune_probe.js`, `check_binding.js`, `client_131042.js`, `list_wabas.js`, `other_waba.js`, `blocked_clients.js`, `send_health.js`, `health_status.js`, `find_failure.js`, `undeliverable.js`, `marketing_reasons.js`, `funding_check.js`, `optin.js`, `assigned_users.js`.

**Two problems:** (1) they are invisible to version control and can collide with a `git pull` on a filename clash; (2) **they leak tokens.** `diagnostic_scope_check.js` puts `access_token` in the query string and its `catch` blocks print raw `err.message`, which can carry the full URL. One run did exactly that: the token appeared in the output file and had to be scrubbed with `sed`. (The same query-string pattern is in the application's own client, `metaClient.graphFetch`, which sets `access_token` as a query parameter on every GET, `server/src/utils/metaClient.js:49`.)

**Spec, not built:** move them into a tracked `scripts/diagnostics/` directory; pass the token as an `Authorization: Bearer <token>` header, never in a URL; and redact in every `catch` (print `err.code` and a scrubbed message, never the raw URL). **Does Meta accept Bearer?** Tested 2026-10-12 with the app access token: HTTP 200 with a `Bearer` header (and with `OAuth`) on a node read (`/{app-id}?fields=name`), on `/debug_token`, and on `/{app-id}/subscriptions`. Meta's messaging-limits page also uses an `Authorization: Bearer` header in its example for the phone-number node. **Not tested** with a client system-user token against every endpoint these scripts use (that needs the VPS); the application already sends Bearer for every non-GET Graph call.

**Paging URLs leak the token even when Bearer is used.** Meta's `paging` object embeds the token in the response body: a templates response carries `"next": "https://graph.facebook.com/v25.0/…/message_templates?access_token=<TOKEN>&…"`. So printing a full response leaks it regardless of how the request was authenticated. **Rule for every diagnostic: redact `paging.next` and `paging.previous` (and any `access_token=` fragment) before anything is printed.** (Source: VPS diagnostic session reported by the project owner, 2026-10-12.) The application's own client has the same problem, and worse for the app secret: see 3.16. (`graphFetch` also puts the client token in the query on every GET, `metaClient.js:49`.)

**`server/scripts/diagnostics/probe_waba.js` is committed (written 2026-10-12; not yet run against Meta)** and probes `1649658386105751` with TNPSC's stored token: `--token-from 894384560175844 --target 1649658386105751`. Read-only (GETs; database in `begin read only`); token only in an `Authorization: Bearer` header (except `debug_token`, which Meta only accepts with `input_token` as a query parameter; POST is refused, tested); `paging` dropped; token, its URL-encoded and JSON-escaped forms, and `access_token=` fragments scrubbed from everything printed; phone numbers masked to the last four digits unless `--show-phone`. Run on the VPS only (`docker cp` it in, then `docker exec -w /app/server wasi-crm node <path>/probe_waba.js …`, or pipe it on stdin).

**What its redaction was actually tested on** (`server/test/probeWabaRedaction.test.js`: the real `probe()` driven against a local fake Graph server, with a synthetic token containing `|`, `+`, `/` and `=` so its raw and URL-encoded forms differ; no database, no Meta):
1. a success body with an `access_token` key inside a data object;
2. `paging.next` and `paging.previous`, both carrying the URL-encoded token;
3. a Graph error body whose message embeds the **raw token** and a URL with `access_token=<encoded token>`;
4. the `debug_token` success path (including a stray `access_token` field in the data);
5. a **non-JSON (HTML) 200 body** containing the raw and encoded token;
6. a **dropped connection** (socket destroyed mid-request), i.e. the network-error path;
7. the per-number tier-field calls (one 200, one 400 whose message echoes the token);
8. phone-number masking.
The assertions: the raw token, its URL-encoded form and any `access_token=<value>` never appear in anything printed; the full phone number never appears; `paging` is replaced, not printed.

**What it was not tested on:**
- **Real Meta responses.** Never run against Meta. The scrubber drops known key names and string-replaces the token's raw, URL-encoded and JSON-escaped forms; a token appearing under a different encoding (base64, truncated, split) would pass through.
- **The real `undici` error `cause` chain** for DNS and TLS failures (only a reset connection was exercised). `graph()` returns `err.code || err.name` and never prints `err.message` or `cause`, which makes it safe by construction, not by observation across failure modes.
- **`loadToken` errors** (a `pg` or `decrypt` failure). `main`'s catch prints `redactString(err.message, null)`; the token is not yet known at that point and `decrypt` errors do not contain plaintext, but I did not exercise it.
- **Uncaught exceptions** outside `main`'s catch (for example a bug in `sanitize` on an unexpected shape): Node's default crash output prints the message and stack unfiltered.
- **The `--show-phone` path**, and any output redirected through other tools.
The diagnostic that leaked a real token did so through an error path that looked safe on inspection; the same caveat applies here. **Scrub the output file before reading it regardless.**

### 3.11 `deploy.sh` has diverged on the VPS

The checkout has an uncommitted modification to `deploy.sh` (backed up on the host as `~/deploy.sh.vps-20261012`). **Before the next deploy: diff it against the repo and commit the difference.** A deploy that pulls may overwrite it. Source: VPS diagnostic session reported by the project owner, 2026-10-12.

### 3.12 Messaging tier: the field works; the bugs are elsewhere (corrected 2026-10-12)

**`messaging_limit_tier` returns a value on some numbers.** On phone `391453774055149` (Sirah Digital) the VPS script printed `"messaging_limit_tier": "TIER_250"` and "field name is correct" (source: VPS diagnostic session reported by the project owner, 2026-10-12). The database agrees: `TIER_250` is stored for Brainlit, Evokz, GV Mart (as of 7 Oct), RD interblocks and Sirah Digital; `unknown` for Fortune Innovatives, Know Mind, TNPSC and the demo (`wabas.messaging_tier`, 2026-10-12). Earlier text in this document that called the field wrong, and then deprecated, is superseded.

**Correction to the premise "our refresh treats an absent value as a failure."** It does not. `messagingTierRefreshRunner.refreshOne` (`messagingTierRefreshRunner.js:42-48`) writes `'unknown'` when the field is absent and stamps `messaging_tier_checked_at = now()`, i.e. it handles absence as a successful "no value". That is why Fortune, Know Mind, TNPSC and the demo show `unknown` with a check from today. What the code does get wrong:
1. **A Graph error never advances the checked-at column**, so a number whose call always fails is "due" on every hourly tick forever (`Sirah`: `messaging_tier_checked_at` is null; GV Mart likewise since its token broke). The same pattern is in the sendability monitor (3.14).
2. **`unknown` is ambiguous downstream.** It means "Meta returned no value", which is not "no tier assigned yet"; `alertRunner` and the broadcast preflight both treat it as "no cap known".

**What distinguishes the numbers that return it? Hypotheses only.** Tested against every attribute stored in `wabas` (code verification status, platform type, `is_on_biz_app`, quality rating, creation date, outbound volume), nothing separates the two groups cleanly:

| | Returned `TIER_250` | Absent |
|---|---|---|
| Code verification | `NOT_VERIFIED` (all 5) | `NOT_VERIFIED` (Fortune, Know Mind), `EXPIRED` (TNPSC, demo) |
| `is_on_biz_app` | true (all 5) | true (Fortune, Know Mind), false (TNPSC, demo) |
| Quality | `UNKNOWN` or `GREEN` | `GREEN` (3), none (demo) |
| Created | 9 Sep to 7 Oct | 17 Aug to 17 Sep (Know Mind: 9 Sep, the same day as Brainlit and RD) |
| Outbound messages | 0 for four, 110 for Sirah Digital | 1,295 (Fortune), 302 (demo), 23 (Know Mind), 14 (TNPSC) |

- **H1 (tier already above entry level):** a number that has graduated past `TIER_250` stops returning the old field. Fits Fortune (high volume) and, loosely, the demo; does not fit Know Mind (23 sent) or TNPSC (14).
- **H2 (portfolio-level limits):** Meta now sets the limit per business portfolio. The legacy per-number field may be omitted once the owning portfolio is on portfolio-level limits. This fits the "set per business portfolio" statement on Meta's messaging-limits page, and would group numbers by portfolio, not by any number-level attribute. Not testable from stored data (the portfolio id is not stored).
- **H3 (the two `EXPIRED` numbers are a separate case):** TNPSC and the demo differ in two ways at once (`EXPIRED`, not on the Business app). Unexplained either way.
- **Experiment, on the VPS:** for all ten numbers in one pass, request `fields=messaging_limit_tier,whatsapp_business_manager_messaging_limit` (separately, so an unknown field cannot fail the call; `probe_waba.js` already does this per number) and compare against the portfolio each belongs to.

**Meta's current guidance** (messaging-limits page, fetched 2026-10-12, summarised; re-read before relying on it): the supported field is `whatsapp_business_manager_messaging_limit` (example value `TIER_250`), and `messaging_limit_tier` "used to return" the limit. **The limit is set per business portfolio and shared by all phone numbers in it.**

> **For whoever owns the plans / pricing document:** per-client capacity figures there are approximations. A portfolio's limit is shared across its numbers and is measured as unique recipients outside customer-service windows in a moving 24-hour period, so two numbers under one portfolio compete for the same allowance, and a client's "tier" is not a property of one number. Our own capacity maths (`routes/broadcasts.js`, `messagingTierRefreshRunner.js`) has the same limitation.

**Fix, not built:** request `whatsapp_business_manager_messaging_limit`, keep reading `messaging_limit_tier` as a fallback, advance the checked-at column on failure (with backoff), and store the portfolio id so limits can be grouped.

**`code_verification_status` = `EXPIRED`** on the demo and TNPSC numbers (Sirah Digital's is `NOT_VERIFIED`). Meta's phone-number page defines `EXPIRED` only for `name_status`. On the evidence it is benign: the demo and TNPSC are registered, `CONNECTED` and sending. It would matter only if a number needed re-registration.

### 3.13 `findAnyConnected` picks the newest connected WABA with no health filter

**Investigated read-only, 2026-10-12. Result: not currently broken; a fragile choice that will fail silently the day it picks a bad token.** This corrects the working assumption (from the VPS session) that the template-library refresh has been broken for the whole platform for five days.

**Callers** (grep across `server/src`): **one.** `metaTemplateLibraryRefreshRunner.refreshNow()` (`metaTemplateLibraryRefreshRunner.js:25`), reached from (a) its hourly `tick()` when the cache is older than 7 days and (b) the admin route `POST /api/admin/template-library/meta/refresh` (`admin.js:884`). It decrypts the returned WABA's token and calls `GET /message_template_library`, whose content is Meta's global catalogue (no client data), then upserts and prunes `meta_template_library_cache`.

**What the selection does:** `select * from wabas where status = 'connected' order by created_at desc limit 1` (`wabasRepo.js:40-42`). Today that is **GV Mart** (created 7 Oct 07:50 UTC), whose token has `public_profile` only (Appendix A).

**What has actually failed because of it: nothing recorded.**
- `meta_template_library_refresh_meta` (2026-10-12): `last_refreshed_at` = **2026-10-08 08:02:31 UTC**, `last_refresh_entry_count` = 25, **`last_refresh_error` = null**. That refresh ran **after** GV Mart's WABA became the newest connected one (7 Oct 07:50), so it used GV Mart's token and **succeeded**. The cache holds 25 rows (oldest `updated_at` 8 Oct 08:02:31).
- The failure path writes `last_refresh_error` without touching the cache (`metaTemplateLibraryRepo.recordRefreshFailure`), and no failure is recorded. The cache is last-known-good by construction.
- The next attempt is due once the cache is more than 7 days old: **15 Oct 08:02 UTC, at the hourly tick.** It will use whatever `findAnyConnected` returns then, so that tick is the first real test of this hypothesis.

> **Dated, testable prediction (recorded 2026-10-12 on the owner's instruction).** On **15 Oct 2026 at about 08:02 UTC** the refresh runner will attempt a refresh using whatever `findAnyConnected` returns (GV Mart, unless a newer connected WABA exists by then). **If it fails** (`meta_template_library_refresh_meta.last_refresh_error` becomes non-null and `last_refreshed_at` stays at 2026-10-08 08:02:31 UTC): GV Mart's scope-less token is the cause, and the explicit-platform-WABA fix below is needed before the next scheduled attempt. **If it succeeds** (`last_refreshed_at` moves to about 15 Oct 08:02 UTC and the error stays null): the catalogue endpoint genuinely does not need WhatsApp scopes, and this item drops in priority (the arbitrary-tenant-token coupling remains, but is no longer a live failure). Either way it is answered on a known date. Check those two columns after 08:10 UTC on 15 Oct; the check is read-only. (Caveats: it assumes no newer WABA is connected before then, and that the runner is up. If the server is not restarted nothing changes; the hourly tick has been running since the last deploy on 1 Oct.)
- **I cannot explain why a `public_profile`-only token succeeded.** GV Mart's sendability checks have failed since the day its WABA was created, so the token very likely had no WhatsApp scope on 8 Oct either. Two readings, neither verified: the catalogue endpoint does not need WhatsApp scopes, or that token had more scope on 8 Oct than it has now. Note that **the app access token does not work as a substitute:** `GET /message_template_library` with `APP_ID|APP_SECRET` returns HTTP 200 with **zero** entries (tested 2026-10-12, with and without filters), so some token with business context is genuinely required.

**Client-visible dependence:** only the "Meta Official" tab of the Template Library (`routes/templateLibrary.js`, `GET /meta`) and `POST /meta/:id/use`, which read the cache. A stale cache means an entry Meta has since withdrawn can still be offered, and "use" would then fail at Meta with a described 502. Nothing else (broadcasts, flows, chat, billing) reads it.

**The fragility, stated plainly:** (1) the token used is an arbitrary client's, chosen by creation date, so a disconnected, revoked or scope-less newest WABA makes the refresh fail; (2) it couples a platform function to one tenant's credential and rate limit; (3) on failure `last_refreshed_at` does not advance, so it retries hourly forever (the bug class in 3.14), with only `last_refresh_error` to show for it, which surfaces only on the admin Settings page.

**Fix, specified, not built.** Options:
| Option | Notes |
|---|---|
| **A. Health filter:** `where status = 'connected' and sendable is true order by …` (fall back to any connected) | Smallest change; still an arbitrary tenant's token, and `sendable` is null for new rows |
| **B. Explicit platform WABA:** an env var (for example `PLATFORM_WABA_ID`) naming a WABA Wasi controls, used for every platform-level Graph call; fall back to A if unset or unhealthy | Deterministic and no tenant coupling. The demo client's WABA (`983390651411856`) is the natural candidate: healthy, both scopes on all targets, already the platform's billing-message sender |
| C. App access token | **Does not work** (empty result, tested) |
Recommended shape: B with A as the fallback, record which WABA id each refresh used in `meta_template_library_refresh_meta`, and apply the 3.14 backoff so a bad token produces one alert rather than an hourly retry.

### 3.14 A permanently failing probe is retried forever: a bug class, not a quirk

**This is the mechanism behind ~1,650 audit rows from one dead WABA row (3.15) and the same shape in two more places.** Corrected 2026-10-12: the earlier "573 failures" was one of three counts; the row produced 574 + 573 + 503 ≈ **1,650** audit rows.

**The rule being violated:** a periodic job selects "due" rows by `checked_at is null or checked_at < now() - interval`, and **only the success path writes `checked_at`**. A row that fails every time is therefore due on every tick, forever. Instances in this codebase:
| Runner | "Due" condition | Failure path writes | Observed |
|---|---|---|---|
| `sendabilityMonitorRunner.tick` (hourly) | `registration_checked_at` null or > 4 h | audit rows only (3 per cycle) | `Sirah` row: exactly 60-minute gaps, 24 per day, 1,650 audit rows; GV Mart: 124 failures at 24 per day since 7 Oct |
| `messagingTierRefreshRunner.tick` (hourly) | `messaging_tier_checked_at` null or > 24 h | console only | `Sirah`: `messaging_tier_checked_at` is null; same hourly retry |
| `metaTemplateLibraryRefreshRunner.tick` (hourly) | `last_refreshed_at` older than 7 days | `last_refresh_error` only | not yet triggered (3.13) |
(An absent *value* is handled correctly: the tier runner stores `'unknown'` and stamps `checked_at`. It is the failed *call* that does not.)

**Spec, not built.** A shared backoff for all three, so a dead row costs a handful of attempts and one alert instead of 24 rows a day:
1. **Advance the clock on failure too.** On every failed attempt write the attempt time and increment a **consecutive-failure counter**; reset both on success.
2. **Increasing interval:** failures 1 to 3 retry hourly (transient blips); failures 4 to 10 retry daily; failure 11 **parks** the row (no further automatic attempts).
3. **One alert on parking**, deduped through `alertEventsRepo` (the existing path), naming the WABA and the last error; **auto-resolve on the next success** or a manual "Check now".
4. **Audit rows only on transitions** (first failure, each interval change, parked), not on every attempt. For the `Sirah` row that is roughly ten attempts and about thirty audit rows over the row's whole life, against 1,650 in 24 days.
5. **Manual override unchanged:** the admin "Check sendability now" and "Refresh tier" routes bypass the schedule and may un-park.
6. **Schema:** a counter and a next-attempt (or last-attempt) column on `wabas`, and the equivalents on `meta_template_library_refresh_meta`. A migration; take the next free number at implementation time (3.4).
This makes the `Sirah` row harmless on its own, and the next dead row too, but it needs a deploy, and nothing is deployable until 3.0 / 3.11 are done. Until then 3.15 option 1 is the stop-gap.

### 3.15 The `Sirah` client's WABA row is probed every hour and always fails

**Record of the investigation, 2026-10-12. Corrected the same day on the owner's reading: this is a cross-client misassignment at onboarding, not a duplicate.** `998094716164113` displays as "Tnpsc Mentors" (number ending 9808) and is a real TNPSC-related WABA that an admin assigned to the `Sirah` client row on 8 Sep via `whatsapp_resolve_waba`. The system user is per business portfolio, not per client. Sources are named per line; the VPS lines are from the VPS diagnostic session reported by the project owner, 2026-10-12, the rest are database and code reads.

**Established**
- **Two client rows, not one client with two WABAs** (`clients`, 2026-10-12). `Sirah`: `30adfd9e…`, `pending_setup`, created 8 Sep 16:34 UTC, email `si***@gmail.com`, last login 7 Oct 14:07 UTC, `token_version` 1. `Sirah Digital`: `6ce697ed…`, `active`, created 21 Sep, email `ri***@gmail.com`, last login 12 Oct. The emails differ. Each client has exactly one `wabas` row.
- **The two WABA rows are different WABAs, not a duplicate; the stale one belongs to TNPSC's business, not to Sirah** (`wabas`). The stale one is `998094716164113`: phone-number id `1147405151797261`, display name **"Tnpsc Mentors"**, number ending `9808`, `verified_at` 8 Sep, status `connected`. The live one is `351363664731426`: `391453774055149`, "Sirah Digital", number ending `1631`. So "stale duplicate of Sirah Digital" is not quite right: it is a different WABA, with a different phone number and a different display name, that the same business's system user was once granted.
- **How it got there** (`audit_log`, `wabas.connect_diagnostics`): on 8 Sep 16:36 UTC the `Sirah` client's connect found two candidates (`wabaTargetIds` `[998094716164113, 351363664731426]`) and recorded `needs_manual_resolution`; on 8 Sep 17:29 an admin resolved it to `998094716164113` (`whatsapp_resolve_waba`), followed by two `retry_provisioning` runs. On 21 Sep `Sirah Digital`'s connect listed `[2073496506618651, 351363664731426]`. **Today** the shared token's `granular_scopes` target only `351363664731426` (VPS), so Meta answers `#100` subcode 33 for the stored WABA ("does not exist, cannot be loaded due to missing permissions").
- **Same token, one system user** (VPS): both rows carry a `SYSTEM_USER` token with user id `122106946323459883`, both with both WhatsApp scopes, both with `target_ids` `["351363664731426"]`. Live-row calls: HTTP 200 on all three; stale row: HTTP 400, code 100, subcode 33. The stale row's own stored probe reason says the same (`wabas.sendable_reason`).
- **What is attached to the `Sirah` client** (every table with a `client_id` column queried; `Sirah Digital` for comparison):

| | `Sirah` (stale row) | `Sirah Digital` |
|---|---|---|
| `wabas` | 1 | 1 |
| `api_keys` | 1 (`CRM Integration`, created 8 Sep, **never used**) | 2 |
| `chats` / `contacts` | 0 / 0 | 140 / 140 |
| `messages` | 0 | 1,298 |
| `message_templates` | 0 | 21 |
| flows / rules / usage_logs | 0 / 0 / 0 | 1 / 2 / 22 |
| team members | 0 | 0 |
| Webhooks keyed by its WABA id (`audit_log`) | **0, ever** | 5,741 |

  Nothing real is attached to the `Sirah` client except one unused key and the dead WABA row. Its audit trail is: key created, needs-manual-resolution, resolve, two retries, a password reset (7 Oct 14:07 UTC; `last_login_at` is the same minute) and a manual sendability check (7 Oct 14:09 UTC), and the sweep rows.
- **The 573 failures are one dead row re-probed every hour** (`audit_log`; `sendabilityMonitorRunner.js`). `tick` runs hourly and selects `status = 'connected'` and (`registration_checked_at is null` or older than 4 h). A **failed** check never writes `registration_checked_at` (only the success path does), so a permanently failing row is due on every tick. Observed: exactly 60-minute gaps, 24 rows per day, one message shape ("Unsupported get request. Object with ID '…' does not exist…", 573 of 574; one `fetch failed`). Each cycle writes three audit rows (`…check_failed`, `sendability_unknown`, `sendable_verdict_computed`): **574 + 573 + 503 ≈ 1,650 audit rows from one dead row**, and 574 of the 744 failures (77%). `messagingTierRefreshRunner.tick` has the same shape (3.12). GV Mart's current row is the same pattern: 124 failures at 24/day since 7 Oct.
- **Which row `findByClientId` returns:** `findByClientId(30adfd9e…)` returns the `998…` row and `findByClientId(6ce697ed…)` returns the `351…` row; there is one row per client, so a lookup can never return the other client's row. The stale row is reachable (i) in `Sirah`'s own client context (its UI shows "connected" for a WABA its token cannot see) and (ii) through the sweeps: `sendabilityMonitorRunner` (`tick` and the admin `refreshNow`), `messagingTierRefreshRunner`, and the `alertRunner` checks. **Every one of them filters on `wabas.status = 'connected'`** (`sendabilityMonitorRunner.js:283,295`, `messagingTierRefreshRunner.js:57,68`, `alertRunner.js:56,110,135,303,324`).
- **A related selection hazard:** `wabasRepo.findAnyConnected` (`wabasRepo.js:40`) returns the newest connected WABA with no health filter. Today that is **GV Mart**, whose token has `public_profile` only, and `metaTemplateLibraryRefreshRunner` uses it (`metaTemplateLibraryRefreshRunner.js:25`) to read Meta's global catalogue. The last audited library refresh was 17 Sep, so I could not tell whether the refresh has failed since 7 Oct; it should prefer a `sendable = true` WABA.

**Options to stop the probing (specified, nothing done).** `wabas.status` has **no CHECK constraint** (only the two forward-config checks), and all 10 rows are currently `connected`.

| Option | Touches | Reversible | Effect | Cost / risk |
|---|---|---|---|---|
| **1. Set `status` to a non-`connected` value on that one row** (existing value `'failed'`), pinned by id, with a hand-written `audit_log` row giving the reason | 1 column of 1 row | Yes (set it back) | Drops the row from every sweep above at once; stops the hourly probe and its ~1,650 audit rows | `'failed'` raises the Admin overview "failed WABAs" tile by one (`admin.js:50`), which is honest; `Sirah`'s UI shows "not connected", which is true. `Sirah` can still re-connect: `upsertForClient` updates the same row |
| 2. Set `status` to a new value (e.g. `'superseded'`) | Same | Yes | Same | No migration, but a status nothing in the UI or admin handles |
| 3. Fix the runners: write the checked-at column on failure, with backoff | Code, a deploy | Yes | Fixes the whole class (GV Mart's 124 too) | Needs a deploy; nothing is deployable until 3.0 / 3.11 are done |
| 4. Delete that one `wabas` row (not the client) | 1 row; only dependent is `webhook_deliveries.waba_id` (0 rows for it) | **No** | Same as 1 | Loses the display name and diagnostics; not a 38-table cascade, but irreversible |
| 5. Delete the `Sirah` client | 38-table cascade | No | Same | **Do not**: the mechanism of the 7 Oct incident, and nothing here needs it |

**TNPSC appears to have more than one WABA, and we do not know which they intend to use.** Three TNPSC-related ids are now on record: `894384560175844` (working, stored on TNPSC's own client), `1649658386105751` (no `wabas` row; 8 message webhooks discarded, 24 Sep to 8 Oct; the token's current scope target) and `998094716164113` ("Tnpsc Mentors" ending 9808, sitting on `Sirah`'s row). **That is a question for the client, not a database fix.** It does not block option 1: disabling the `Sirah` row loses nothing, the WABA at Meta is untouched, and re-enabling is one statement. Ask in parallel.

**Least destructive: option 1, one row, one column.** Before doing it: (a) the owner should say whether the number ending `9808` ("Tnpsc Mentors") is wanted, because it is a real WABA that a system user was once granted and may simply need re-granting rather than abandoning; (b) 3.8's audit and role gate do not apply to a `wabas` update, so write the `audit_log` row by hand; (c) it is a production write and needs your explicit approval. **Not done.**

**Option 1 was APPROVED with conditions and EXECUTED on 2026-10-12 at 16:52:42 UTC on the owner's go** (Statement 1 only; result: the `DO` block committed, which implies the exactly-one-row assertion passed; `wabas.status` is now `failed`; audit row `04920fbf-acd2-48f0-be9a-6928a2d9ad5f`, action `manual_db_change`). Statement 2 was not run. Before the change `Sirah` had 574 `sendability_registration_check_failed` rows (last 16:02:42 UTC); the proof that it worked is that no new one appears at the next hourly ticks. **Observed at the 17:02 UTC tick (read 17:06:10 UTC):** `Sirah` stayed at **574** failed rows and **1,651** `sendability_*` rows (last failure still 16:02:42 UTC), while the control, GV Mart, went 124 to 125 failed (17:02:34 UTC) and 375 to 378 rows, and nine sendability rows were written in the 17:02 minute in all. So the tick ran and the `Sirah` row was excluded. One tick is one observation; the exclusion holds for later ticks because every sweep filters on `status = 'connected'`. The original conditions: Conditions and how each is met:
- **Status value already handled by the sweeps and the Admin UI; no new value: `'failed'`.** Consumers:

| Consumer | Where | Effect on this row at `'failed'` |
|---|---|---|
| Sendability sweep (`tick`, admin `refreshNow`) | `sendabilityMonitorRunner.js:283, 295` (`status = 'connected'`) | Excluded; probing stops |
| Tier sweep | `messagingTierRefreshRunner.js:57, 68` | Excluded |
| Alert checks | `alertRunner.js:56, 110, 135, 303, 324` | Excluded |
| Admin overview "failed WABAs" count | `admin.js:50` (`status = 'failed'`) | +1, which is honest |
| Admin onboarding queue | `admin.js:80` (`failed` only matters when `client_status = 'payment_confirmed'`) | No change: `Sirah` is `pending_setup` |
| Admin UI badge | `admin/app.js:203` (`failed: 'danger'`) | Renders red "Failed" |
| Admin "needs attention" flag | `admin/app.js:1348` (only `needs_manual_resolution`, `incomplete_meta_linked`, `sendable === false`) | No change (`sendable` is null) |
| `retry-provisioning` | `admin.js:113` (no special case for `failed`) | Generic path; would fail again with `#100`; harmless |
| Client app | `routes/onboarding.js` `GET /whatsapp/status` returns `connected: status === 'connected'`; `app.js:4504, 4585, 5926` | Shows not connected (true) and offers Connect; `onboarding.js:294` already writes `'failed'`, so the state already exists |
| Reconnect | `wabasRepo.upsertForClient` updates the newest row in place | A reconnect rewrites this same row |

- **Pinned by the `wabas` row id, not `waba_id` or `client_id`:** `362e1974-93dc-4ad9-ace2-8381f154f437` (confirmed 2026-10-12: one row for that client; `waba_id` `998094716164113`; current status `connected`).
- **One transaction; exactly 1 row affected or it rolls back; the current value is recorded so the rollback is one statement.** Current value: **`'connected'`**.

**How the audit row is attributed (changed 2026-10-12 on the owner's instruction).** The row must not credit the shared super_admin for something a person did out of band. Checked in `audit_log` (2026-10-12): `actor_type` is free text (no CHECK constraint); values in use are `meta_webhook` (19,427 rows), `system` (5,123), `admin` (960) and `client` (611); `actor_id` is a nullable `uuid` (NULL on all `meta_webhook` rows and on 26 `system` rows). **`'system'` is the only existing value that is not a person or a tenant, so it is used, with `actor_id` NULL.** Two caveats, stated so nobody has to rediscover them: (1) every other `system` row is an automated runner, and most of them put the *affected client's id* in `actor_id` (the sendability runner); I deliberately do not do that here, because it would attribute a manual change to the client; (2) `'system'` therefore blurs "a runner" and "a person at a prompt". The distinguishing signal is the **distinct action name `manual_db_change`** (no code keys on it or on `actor_type = 'system'`) and a `target` that states plainly that it was applied out of band, by whom and why. No new `actor_type` value is introduced. The target begins with the **client id**, so the row appears in that client's audit trail on the admin Client Detail page (`auditLogRepo.list` matches `target like <client id> || ': %'`). **"By whom" is written as "the platform owner (Jesheeba)" (the owner chose this wording on 2026-10-12: a git author identity names a commit identity, not the person who ran the statement, and does not belong in a permanent audit row).**

**Statement 1 (apply):**
```sql
DO $$
DECLARE n integer;
BEGIN
  SET LOCAL lock_timeout = '5s';
  UPDATE wabas SET status = 'failed'
   WHERE id = '362e1974-93dc-4ad9-ace2-8381f154f437' AND status = 'connected';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 row, updated %', n; END IF;
  INSERT INTO audit_log (actor_type, actor_id, action, target)
  VALUES ('system', NULL, 'manual_db_change',
          '30adfd9e-413f-4dbf-adcc-7fec1c522dbd: wabas row 362e1974-93dc-4ad9-ace2-8381f154f437 status connected -> failed. '
          || 'MANUAL SQL CHANGE applied out of band (psql), not through the admin UI or any app route, '
          || 'by the platform owner (Jesheeba) at ' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"')
          || '. Reason: WABA 998094716164113 is not in its token''s scope and was being re-probed hourly; '
          || 'see docs/ai-agent/BUILD_PLAN.md 3.15. Rollback: set status back to connected on that row id.');
END $$;
```
A `DO` block is a single atomic statement: any exception (the count assertion, the lock timeout, the audit insert) rolls back both writes. **Statement 2 (rollback):**
```sql
DO $$
DECLARE n integer;
BEGIN
  SET LOCAL lock_timeout = '5s';
  UPDATE wabas SET status = 'connected'
   WHERE id = '362e1974-93dc-4ad9-ace2-8381f154f437' AND status = 'failed';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 row, updated %', n; END IF;
  INSERT INTO audit_log (actor_type, actor_id, action, target)
  VALUES ('system', NULL, 'manual_db_change',
          '30adfd9e-413f-4dbf-adcc-7fec1c522dbd: wabas row 362e1974-93dc-4ad9-ace2-8381f154f437 status failed -> connected (ROLLBACK of the earlier manual change). '
          || 'MANUAL SQL CHANGE applied out of band (psql) by the platform owner (Jesheeba) at '
          || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') || '.');
END $$;
```
**Verify after applying:** `select status from wabas where id = '…'` returns `failed`; then, at the next hourly tick (at most about 60 minutes), no new `sendability_registration_check_failed` row appears for client `30adfd9e…`. No session-level `SET` is used (`SET LOCAL` only, inside the block). **Not executed.**

### 3.16 The Meta app secret is put in request URLs (3 places)

**The app secret is the credential for the whole platform app, across every client; this is worse than an access token in a URL.** Where (`server/src/utils/metaClient.js`): line 81 (`exchangeCodeForToken`, `client_secret` query parameter), line 101 (the long-lived exchange, `client_secret`), and line 127 (`debugToken`, `access_token=${META_APP_ID}|${META_APP_SECRET}`). Investigated read-only 2026-10-12, using harmless calls with the app's own credentials only:

**Is the URL ever logged?** Not by anything I could find.
- Application code: no call site logs the URL. `fetchWithTimeout` (`metaClient.js:20-29`) rethrows a network error unchanged; Node's `fetch` raises `TypeError: fetch failed` whose `cause` carries the network error, not the request URL (I did not exercise every failure mode). The callers log `.message` only (for example `onboarding.js:195`, `discoveryErr.message`), and the audit rows store `err.message`.
- `audit_log`: **zero** rows contain `access_token=`, `input_token`, `Bearer `, an `EAA…`-shaped token, or an `APP_ID|SECRET`-shaped string (6 patterns, queried 2026-10-12). The only rows mentioning `app_secret` are 3 `whatsapp_connect_failed` rows from 16 Aug reading "META_APP_ID / META_APP_SECRET are not configured", with no value.
- Upstream: nginx on the VPS logs inbound requests only; it does not see the outbound call. **Not examined (no access from here): the container's stdout log, any egress proxy, and Meta's own side.**

**Does Meta accept the secret outside a URL?** Yes for all three sites (tested 2026-10-12):
| Site | Test | Result |
|---|---|---|
| `debug_token` (127) | `Authorization: Bearer APP_ID\|SECRET`, `input_token` as query parameter | HTTP 200, `is_valid` true. The app secret leaves the URL; `input_token` (a client token) stays in it |
| `debug_token` | `POST` with a form body | **Refused**: HTTP 400, code 100. `input_token` must stay a query parameter |
| `oauth/access_token` code exchange (81) | `POST`, `client_id` / `client_secret` / `code` in a form body | Parameters parsed: HTTP 400 "Invalid verification code format", the same answer as the `GET` (dummy code) |
| `oauth/access_token` long-lived exchange (101) | `POST` form body with `fb_exchange_token` | Parameters parsed: HTTP 400 code 190 about the dummy token |

**Does it appear in an error path, as the access token did in `diagnostic_scope_check.js`?** On the evidence: no. `debugToken` throws `data?.error?.message || 'debug_token failed (status)'`, which is Meta's message, not the URL; a network error is rethrown raw, whose `message` is `fetch failed`. The remaining risk is that a *future* handler prints the error object or its `cause`, or that the container log captures something I could not see. **I cannot rule out the container log; whether the secret needs rotating is the owner's call and I have no evidence that it leaked.**

**Decision (owner, 2026-10-12): DO NOT ROTATE the app secret now.** Recorded with its reasoning so nobody re-opens it without it: (1) there is no evidence of exposure (nothing in `audit_log`, no log line seen, no error path observed); (2) rotating the app secret re-issues **every client's token** (the long-lived tokens are derived under it), which means asking nine clients to re-authorise; (3) the same investigation established that **inconsistent token provisioning at onboarding is the root cause of three separate client failures** (3.15, Appendix A), so mass re-issue now would be done on a provisioning path that is itself unreliable, producing new failures on the day the old ones were diagnosed. **Instead:** fix the three call sites so the secret never touches a URL (below), then revisit rotation as a **scheduled hygiene task** once onboarding token scopes are fixed and verified, not as incident response. Re-open only on new evidence of exposure.

**Fix, specified, not built:** (1) move `client_secret` and `client_id` into a `POST` form body for both token exchanges (lines 81 and 101); (2) send the app token for `debug_token` as an `Authorization: Bearer` header (line 127); (3) wrap `fetchWithTimeout` so a rethrown error carries only its `code` or `name`, never the URL or `cause`; (4) add a test that a thrown error from each of these three calls contains neither the app secret nor a client token.

### 3.17 `alertRunner.checkWabaRestrictions` has no status filter: a sweep with no exit condition (found 2026-10-13)

**Status:** fixed in the Disconnect WhatsApp unit (see 3.18).

`checkWabaRestrictions` (`alertRunner.js`) selected every `wabas` row with `restriction_status is not null`, with no `status = 'connected'` filter, unlike the other four sweeps. Any non-connected row (`failed`, `needs_manual_resolution`, now `disconnected`) carrying a restriction therefore raised a critical alert forever, with no way to close it. Same family as 3.14 (the retry bug class) and the Sirah row (3.15): a sweep whose loop has no exit condition. Fix: `where w.status = 'connected' and w.restriction_status is not null`.

### 3.18 No way to disconnect or retry a WhatsApp connection; the only route was deleting the client (fixed locally 2026-10-13)

**Status:** built, committed locally, not pushed or deployed.

GV Mart's client was deleted twice in six days (7 Oct and 13 Oct) because there was no retry path, and `DELETE /api/clients/:id` cascades across ~38 tables with no audit. Built: a `disconnected` status, client and admin disconnect actions with a typed-name server-side confirmation, a pre-confirmation impact summary, an audit row, and a connect path that never mutates a working row until Meta confirms. Decisions (owner, 2026-10-13): new `disconnected` value rather than overloading `failed`; the encrypted access token is nulled on disconnect **and** `clientNotifier.resolveSenderWaba` checks status (nulling closes this row, the status check closes every future caller that resolves a WABA by "has a token" instead of "is connected"); an ambiguous discovery or a failed attempt never mutates a `connected` row. `wabas.waba_id` is UNIQUE, so reconnect **reuses** the disconnected row in place; `findByClientId` is untouched.

**Limitation to revisit when offboarding exists:** webhooks keep arriving for a disconnected WABA because nothing is unsubscribed at Meta (by design: no Meta calls). They are still ingested and forwarded, which loses nothing. If a client disconnects because they are leaving Wasi, continuing to ingest their customers' messages has a privacy dimension. Not solved here.

---

## 4. Security and infrastructure

### 4.1 Make the repository private

**Order matters and getting it wrong breaks production.**

> **Verified 2026-10-12 (source: VPS diagnostic session reported by the project owner, 2026-10-12).** Production is a **VPS** (nginx on Ubuntu, `187.77.186.31`, Docker Compose, manual `deploy.sh`), not Render; `render.yaml` and `DEPLOY.md` are stale. **The checkout at `/opt/wasi` has `origin` = `https://github.com/Jesheeba/Wasi.git` over HTTPS with no credential helper, so flipping the repository to private WILL break the deploy.** The deploy-key sequence below is therefore confirmed necessary, not precautionary. If a Render service still exists, it would need the Render GitHub app on the repo or it breaks the same way.

1. Create a deploy key for the VPS.
2. Add the public half to the repository's deploy keys.
3. Change the VPS remote to the SSH URL.
4. **Prove it:** `git ls-remote` over SSH from the VPS, successfully, while the repository is still public.
5. Only then flip the repository to private.

An unauthenticated `git pull` fails on a private repository. Flipping first breaks the deploy.

> **DECISION 2026-10-13 (owner): the push is HELD.** Reason: the rotation is NOT complete, and this is not about the documents' contents. Appendix C found only 2 accounts carrying `token_version >= 2` (the admin and the demo client). **32 accounts matching the published defaults were missed: Vetri Academy (Demo) and the 31 leftover test accounts.** Vetri has not been reset and can still log in. Handover 4.11's statement is therefore currently true, and publishing it to a public repo points at a live credential. Once the repository is private, nothing in the unpushed commits matters. The ordering below is load-bearing; each step is its own approved write:
> a. Reset Vetri Academy's owner password via the admin reset-password endpoint, response discarded.
> b. Delete the 31 test accounts using the transaction specified in Appendix C: pinned id list, count assertions of 31/18/14, commit only on match.
> c. Deploy key on the VPS, then **prove it**: `git ls-remote` over SSH from `/opt/wasi` must succeed while the repository is still public (origin is HTTPS with no credential helper, so flipping private first breaks the deploy).
> d. Flip the repository to private. Then push.

**Before any push, separately:** the unpushed commits publish operational detail (client names, WABA and phone-number ids, a client phone number, and a statement that the three default seed passwords still worked in production). Confirm rotation covered the demo client, the third seeded default and the 31 leftover test accounts, not only the admin account. See the 2026-10-12 audit in Appendix C.

### 4.2 Nightly `pg_dump`

**This is the single highest-value item in this document, and it is sequenced before the delete-route work (3.8):** with a tested restore a wrong delete is recoverable; without one no route hardening helps. It is the only thing that would make a deletion like the 7 Oct one (2.4) reversible, and none exists.

Minimum: nightly `pg_dump` to object storage, 14 days retained, **and a restore tested once into a scratch database.** An untested backup is not a backup.

Supabase Pro at $25/month gives 7-day daily backups; PITR is $100/month per 7 days. Note that Supabase backups **exclude Storage API objects**, so media needs its own copy. Decide between paying Supabase and running your own dump — but do one of them this week.

### 4.3 Remaining items

| Item | Note |
|---|---|
| Push the `clients.status` finding | Found, never pushed. |
| Confirm `.claude/` is in `.gitignore` **and committed** | Claude Code session transcripts live under the project directory. This is why rotated passwords must never be printed into a session. **Verified 2026-10-12: in `.gitignore` yes, committed no.** The `.claude/` line (`.gitignore:19`) is an uncommitted working-tree change; `HEAD`'s `.gitignore` only ignores `.claude/scheduled_tasks.lock`. `git ls-files .claude` is empty, so nothing under it is tracked. |
| `clients.status` enforces nothing | A suspended client can still send. Fixed in Phase 0.5. |
| **OPEN: Vetri Academy (Demo) owner password is still the published default** | The only live exposure found by the 2026-10-12 audit (`demo+vetri-academy@wasi.local`, `status` active, `token_version` 0; the default has been public since 23 Sep, `9cb7eeb`). **Not yet reset** as of this edit. Agreed route: `POST /api/clients/:id/reset-password` from an admin session, **response discarded** (it returns a random temporary password once; an unknown random password closes the exposure). No deploy needed; the route is in the deployed image (`511ea49`). Do **not** re-run `seedLandingDemo.js` against production: it restores the default. Close this row only when the reset has been done and a login with the old default has been shown to fail. |

### 4.4 Standing constraints — these do not expire

These were established during the investigation and remain in force for every future session.

- **Never print a secret.** Name the variable, the commit and the file. Never the value.
- **Never restore over production.** It would undo the password rotation and two days of every client's messages.
- **Never rewrite git history.**
- **Never delete the Supabase project `fsunrjithwcjtsutsgea`.** It is GV Mart's live backend, referenced in their `.env`, three GitHub workflows, and shipped Android and iOS app assets.
- **Autovacuum on `messages`/`chats`/`contacts` was re-enabled on 2026-10-12** (recovery closed by decision, 2.4). Do not freeze it again without a named recovery plan and an end date.
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

> **Priority note, 2026-10-12.** The VPS session proposed de-prioritising echo handling because two numbers checked report `is_on_biz_app` false. The stored data contradicts that: `wabas.registration_is_on_biz_app` is true for 7 of 10 connected WABAs (Brainlit, Evokz, Fortune Innovatives, GV Mart, Know Mind, RD interblocks, Sirah Digital), so Coexistence echoes are plausible for most clients. Either way the check must be repeated per client at onboarding. A live per-WABA confirmation (`GET /{phone-number-id}?fields=is_on_biz_app,platform_type`) needs the VPS; it has not been run for the other eight. Whether to de-prioritise is the owner's call on that evidence.

> **Corrected 2026-10-12.** An earlier version of this document excluded `insertEcho`; `SPEC.md` section 7 was right and that exclusion was wrong. **Is the id-match condition load-bearing?** Not on current evidence. Meta's Coexistence documentation lists only the WhatsApp Business app and supported companion devices as triggers for `smb_message_echoes`, and does not list Cloud API sends (inferred from the trigger list; the page does not say so outright). There is no live evidence either way, because the field has never been subscribed (1.1). So treat the condition as defensive, but keep it. `insertEcho` already does `on conflict (meta_message_id) do nothing`, so the write must be gated on that insert having actually inserted a row. One residual race: an echo that arrives before Wasi's outbound row has been given its `meta_message_id` would insert a duplicate row and count as human activity.

### 5.3 Refusal is a first-class output

The model may return `NEEDS_HUMAN`. That is a success, not a failure. It routes the chat to a human and is logged separately from errors. Measure it: a healthy agent refuses often early on, and the refusal rate falling over time is the signal that knowledge is improving.

### 5.4 Cost

Claude Haiku 4.5 at $1 / $5 per million tokens (input / output).

**Prompt caching does not engage at Wasi's prompt size (corrected 2026-10-12).** The earlier reason here was traffic shape: cache writes cost 1.25× and reads 0.1×, with a 5-minute default TTL, and on sparse, bursty traffic the write cost is paid repeatedly. That is true but secondary. The decisive reason is that **Haiku 4.5's minimum cacheable prefix is 4,096 tokens** and the spec's prompt is about 3,000 (rules and profile ~300, knowledge up to 2,500, conversation ~200), so a cache marker silently does nothing (`cache_creation_input_tokens: 0`). Record `tokens_cached` anyway so it is measured. This also means `SPEC.md` §12's "cache hit ~₹0.22" figure is not the expected case: the real figure is about **₹0.45 per reply all in**. See `SPEC.md` decisions 19 and 20.

**Per-message cost assumptions may move by an order of magnitude.** Haiku 4.5 is held through Phase 1 on purpose, so the shadow run produces a baseline against a fixed variable. Claude Haiku 5.5 is listed at $0.10 / $0.50 per MTok (prompts up to 100K) against $1 / $5, roughly 10x cheaper, and it rejects non-default sampling parameters, so the spec's `temperature` 0.3 would be a 400. Whether to move is its own evaluation task (E1, section 7), started as soon as Phase 1 shadow provides a quality baseline (raised 2026-10-13), not something to decide mid-build. **The unit economics are unresolved: see 5.5.** Do not publish a per-message price, or size the add-on, on the Haiku 4.5 figures alone.

### 5.5 Unit economics — UNRESOLVED (recorded 2026-10-13, owner)

**The AI feature's unit economics are unresolved, and the ₹1,499 tier cannot absorb unlimited AI replies.** At about ₹0.445 per reply all in (`SPEC.md` §12.1, decision 19), a client taking 4,000 AI replies a month costs about ₹1,780, which is more than the ₹1,499 plan price. Nothing below is built. Four options are specified so the choice can be made on numbers, and they combine: they are not alternatives.

**Common basis.** Haiku 4.5, 3,000 input + 150 output tokens per reply, ₹88 to the dollar, Meta service message ₹0.115, no caching (the prompt is under Haiku 4.5's 4,096-token cache minimum). Each 100 input tokens is ₹0.0088 per reply; the 150 output tokens are a fixed ₹0.066; Meta's ₹0.115 is fixed.

| | Per reply, all in | Per 1,000 replies | Per 4,000 replies | vs ₹1,499 at 4,000 |
|---|---|---|---|---|
| **Baseline: Haiku 4.5, ~3,000 in** | ₹0.445 (model ₹0.330 + Meta ₹0.115) | ₹445 | ₹1,780 | 119% |
| Option 3a: trim the fixed parts (~190 tokens) | ~₹0.428 | ₹428 | ₹1,712 | 114% |
| Option 3b: lower the knowledge cap 2,500 → 1,500 | ~₹0.357 | ₹357 | ₹1,428 | 95% |
| Option 4: Haiku 5.5, uncached, same prompt | ~₹0.148 (model ₹0.033 + Meta ₹0.115) | ₹148 | ₹592 | 39% |

**Option 1: a per-plan reply cap.** The meter already exists (`monthly_cap`, gate 6; default 1,000). It bounds the cost and does not fix the price. Cost at the cap, on the baseline: 500 replies ₹223 (15% of ₹1,499); 1,000 replies ₹445 (30%); 1,500 replies ₹668 (45%); 2,000 replies ₹890 (59%). On Haiku 5.5 the same caps cost ₹74 / ₹148 / ₹222 / ₹296. Cost: nothing to build; the decision is which number goes in which plan, and what a client at the cap is told (decision 6).

**Option 2: an add-on price.** Price needed for a target gross margin = replies x ₹0.445 / (1 - margin). 1,000 replies: ₹890 at 50%, ₹1,113 at 60%, ₹1,483 at 70%. 2,000 replies: ₹1,780 at 50%. On Haiku 5.5 (₹0.148): 1,000 replies ₹296 at 50%; 2,000 replies ₹592. Reference point only: AiSensy's add-on is ₹1,350/month (`SPEC.md` §4.3), which covers about 1,517 baseline replies at a 50% margin, or about 3,034 at none. This is decision 3, still open.

**Option 3: prompt-size reduction.** Where the ~3,000 input tokens go (measured from the actual spec text, English at chars/4; Tamil and mixed script run higher, so measure with `count_tokens` on real shadow prompts before acting):

| Block | Tokens (typical) | Notes |
|---|---|---|
| 1. Role and rules (`SPEC.md` §9.1) | ~390-420 | 1,686 chars, 286 words. Fixed, not client-editable. It is the Meta-compliance block |
| 2. Business profile (§9.2) | ~50-75 | 7 short fields |
| 3. Knowledge (`knowledge_md`) | 0-2,500 (capped); ~2,000 for a typical full FAQ | **The only large, variable block.** It is the client's own content |
| 4. Conversation, last 6 turns (§9.4) | ~120 typical (6 short turns); up to ~750 worst case (6 x 500 chars, English) | The current inbound message is inside this block |
| Gates | **0** | Gates are code, never in the prompt. There is nothing to trim there |
| **Total** | **~2,600 typical; ~3,000-3,700 at the cap** | Output is separate: ~150 tokens |

Input is about 80% of the model cost (₹0.264 of ₹0.330) and about 59% of the all-in cost. The honest reading is that the fat is **not** in the fixed parts: trimming the rules block by about 130 tokens and truncating history from 6 turns to 4 saves about ₹0.017 per reply (about 4%), and the rules block is the part that holds Meta platform access up, so it is the worst place to cut. The one large lever is knowledge: each 1,000 tokens is ₹0.088 per reply (about 20% of all-in). Whether any of it is trimmable depends on what clients actually paste, so the evidence is the average and distribution of `knowledge_tokens` per client once the shadow set exists, and whether answer quality falls when pasted marketing copy is removed. Even a prompt cut to nothing leaves ₹0.181 per reply (output + Meta, 41% of today's cost), so removing all input would save at most about 59% of the all-in cost, and realistically 5-20%. Not 2x.

**Option 4: Haiku 5.5.** Listed at $0.10 / $0.50 per MTok for prompts up to 100K, against $1 / $5. Model cost falls from ₹0.330 to about ₹0.033 per reply; **Meta's fee then becomes about 78% of the cost**, which makes the Meta pricing question (below) the largest remaining lever. It rejects non-default sampling parameters (the spec's `temperature` 0.3 would be a 400), and its cache minimum is lower (512 tokens per Anthropic's reference, to be re-verified) so caching may engage on a 3,000-token prompt. Untested for reply quality, Tamil and `NEEDS_HUMAN` behaviour. This is evaluation task E1, **raised on 2026-10-13 from "after Phase 1" to "as soon as Phase 1 shadow provides a quality baseline"**, so the answer arrives while it can still change the price.

**Sensitivity that is not engineering and is not settled: Meta's service-message fee.** `SPEC.md` assumes ₹0.115 per agent reply and flags it VERIFY. A web search on 2026-10-13 returned conflicting, secondary-source reports: service messages inside the 24-hour window were free through early 2026 ([AiSensy, Jan 2026 pricing note](https://m.aisensy.com/blog/whatsapp-per-message-pricing-update-effective-january-1-2026/)); and from 1 October 2026 they become chargeable at the utility rate (reported ₹0.115 by [Free Press Journal](https://www.freepressjournal.in/tech/how-much-does-india-have-to-pay-for-whatsapp-messages-from-october-1)), with a reported 1,000 free service messages per WABA per month ([AiSensy, Oct 2026 note](https://m.aisensy.com/blog/whatsapp-pricing-update-october-2026/)). **None of this was confirmed against Meta's own rate card**, and sources disagree on the utility rate (₹0.145 vs ₹0.115). If the 1,000-free allowance is real, a client under 1,000 replies a month pays no Meta fee at all, and the baseline falls to model cost only (₹0.330 per reply). Verify on Meta's India rate card before pricing anything.

**Nothing is decided.** Do not publish a price, or size a plan's reply allowance, until Option 4's quality evidence and the Meta fee are both known.

`cost_paise` is stored as an **integer**. Never a float. Never a currency type.

---

## 6. Phase 0 — foundations

**Nothing AI-specific ships here. Three of these five items are correctness fixes that earn their keep regardless.**

### 0.1 `chats.last_inbound_at`

Written on every inbound message in `chatsRepo.insertInbound`.

**Why it matters beyond the agent:** you currently cannot determine from the database whether a chat's 24-hour customer service window is open. This is the gap behind any `session_window_closed` send failure in general (Section 2.2 states the platform rule). With this column, `session_window_closed` becomes predictable before the send rather than discovered after it.

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

**Gate (owner decision, 2026-10-12): P4 is NOT a gate on this unit.** The unit blocks `suspended` only. 0 of 44 client rows are `suspended`, so it is a no-op today and cannot cut anyone off. P4 (GV Mart on a real, active row with a working token) remains a gate on **3.5, moving GV Mart**, and on any design that blocks non-`active` clients. Do not conflate the two again. **No gate remains for 0.5 (owner decision, 2026-10-13): P5, the per-person admin audit in 3.9, is dropped as a gate and is its own high-priority backlog item.** One correction to the reasoning recorded with that decision: "nothing suspends automatically" is not quite true. `paymentReminderRunner` (started in `index.js`) auto-suspends a client 5 days after an admin marks them unpaid (`auto_suspended_for_nonpayment`). No client is marked unpaid today (0 of 14 non-test clients; 0 auto-suspended), so it is a no-op now, but once 0.5 ships the first such suspension will cut off sends without a person flipping a switch on that day. That is the feature working as designed; it is a reason to make sure the admin can see who is suspended and why (the Client Detail banner already does), not a reason to hold 0.5.

**Rejection logging: carry its own, do not wait for 3.6.** Recommended 2026-10-12. 3.6 (a general request log) is unbuilt and unscheduled, and waiting would leave this the one send rejection nobody can see for as long as it takes. Write a single `audit_log` row per client per hour (action `send_rejected_client_suspended`, `actor_type` `system`, `target` the client id plus the error code), throttled by an existence check on the last hour. The throttle is not optional: a suspended client's integration can retry every second, and the unthrottled version of this is exactly the 1,650-row flood described in 3.14. It is queryable with the existing audit tooling today and is replaced, not duplicated, when 3.6 lands. Do not widen it to `session_window_closed` in the same unit; that is a separate, smaller change.

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

> **HARD PRECONDITION (P6), ahead of every Phase 1 unit — added 2026-10-12, owner-accepted.** Shadow mode sends customer message text, and the client's knowledge, to a third-party model provider. It sends nothing to the customer, but it is **not** "nothing leaves our infrastructure", and shadow mode runs on real traffic. No Phase 1 unit may make a model call on real client traffic until all three of these exist:
>
> 1. **A privacy policy clause** that says AI features send message content to a named provider, what is and is not sent, retention, whether it is used for training, and that the feature is off unless the client turns it on (`SPEC.md` §11.1). The policy is placeholder text today.
> 2. **A consent position per client**, recorded: who agreed, when, to which exact wording (`SPEC.md` §11.2, `ai_agent_consent_events`). Shadow mode runs only for a client who has agreed, one client first.
> 3. **A decision on whether clients must tell their own customers** that an AI processes their messages.
>
> **Item 3 is a legal question, not an engineering one, and so is the wording of item 1. It needs an actual lawyer, not our judgement.** Engineering can build the consent record and the toggle; it cannot decide what the clause must say, or whether the client's own customers must be told, and must not guess. This does not block Phase 0, or Phase 1 code written and tested against stubs.

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

**Evaluation task E1: Claude Haiku 5.5 (opened 2026-10-12; raised 2026-10-13 from "after Phase 1" to "as soon as Phase 1 shadow provides a quality baseline"; not part of Phase 1's build).** Haiku 4.5 is held through Phase 1 so the shadow run is a cost baseline against a fixed variable. Once the shadow set exists, evaluate Haiku 5.5 as its own task: (a) measured cost per turn on the same shadow messages; (b) what to do about sampling, since it rejects non-default `temperature` and the spec pins 0.3; (c) whether reply quality and the `NEEDS_HUMAN` refusal behaviour hold on the shadow set; (d) whether its lower cache minimum makes caching engage. A roughly 10x per-token price difference changes the unit economics behind the add-on price, so the answer feeds `SPEC.md` decision 3, not just a model setting.

---

## 8. Phase 2 — suggested reply, then live

Two sub-steps. Do not merge them.

**2a — suggested reply.** The draft appears in the Wasi inbox as a one-click suggestion. A human sends it, edits it, or discards it. Record which. This is the last cheap source of evaluation data and it is also a feature worth selling on its own.

**2b — auto-send, one client.** The agent sends when all gates pass. Start with the single client whose shadow results were best. Keep a kill switch per client that takes effect on the next turn, not the next deploy.

> **HARD RULE (owner, 2026-10-12): the `smb_message_echoes` subscription must be live and verified BEFORE 2b.** 7 of the 9 connected WABAs are Coexistence, and the app is not subscribed to the echo field today (0 echo-sourced messages, ever). While it is not, `last_agent_reply_at` cannot move for a reply sent from the owner's own phone, gate 4 cannot see the human, and the agent would answer on top of them in front of their customer. "Verified" means a real echo captured: an `audit_log` row for the field and a `messages` row with `source = 'whatsapp_app'`. Until then, the only protection for those clients is the `outside_hours` schedule, which narrows the exposure and does not close it. The agent must not go live on a Coexistence client while it is blind to phone replies. Subscription also has an ordering constraint already recorded in 3.0: production must run `cb27227` first. Do not subscribe `history` until a handler exists.

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
BLOCKING   2.1 debug_token (run for 3 of 10 WABAs; run the rest)
                              ├──> fix token scopes at onboarding / re-onboard GV Mart, TNPSC
                              ├──> 2.6 Evokz (run the script first; payload fix only if still needed)
                              ├──> 2.3 alerting
                              └──> 3.5 GV Mart off demo client (cannot work until its token has scopes)
           2.2, 2.4, 2.5: closed 2026-10-12

FLOOR      4.2 nightly pg_dump + TESTED restore     (first; outranks everything below)
           3.9 per-person admin accounts + deploy admin login audit
           3.8 DELETE /api/clients/:id fix           (after 4.2 and 3.9)
           4.1 repo private (deploy key proven first; HTTPS remote CONFIRMED)
           3.10 / 3.11 move diagnostic scripts into the repo; commit deploy.sh drift (before any deploy)
           3.13 platform-level Graph calls must not pick an arbitrary tenant's token (health filter or explicit platform WABA)
           3.14 backoff for permanently failing probes (counter + increasing interval + one alert)
           3.15 stop the hourly dead-row probe (APPROVED, one-row status change, NOT executed; run on the owner's go)
           3.16 move the Meta app secret out of request URLs (3 places)
           4.3 OPEN: reset the Vetri Academy (Demo) password (admin route, response discarded)
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
  - Autovacuum on messages, chats and contacts was re-enabled on 2026-10-12. Do not change it.
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

**Source:** `diagnostic_scope_check.js`, run on the production VPS (the only machine that can decrypt WABA tokens) in a session reported by the project owner, 2026-10-12. Reported, not independently re-run. No token value is reproduced here; ids and scope names only.

| WABA | Client | Token scopes | `granular_scopes` | Calls | Verdict |
|---|---|---|---|---|---|
| `983390651411856` | Demo / "Sirah" | `whatsapp_business_management`, `whatsapp_business_messaging`, `public_profile` | present, **no** `target_ids` (applies to all) | all three HTTP 200 | Healthy |
| `894384560175844` | TNPSC mentors | same two plus `public_profile` | `target_ids` = `["1649658386105751"]`, **not** the stored WABA | templates 200, `phone_numbers` 200 (reads work, writes do not) | `#200`: scope targets a different id than the stored WABA |
| `1766605231203643` | GV Mart | **`public_profile` only** | none | every call HTTP 400, code 100, subcode 33 | `#100`: token has no WhatsApp permission at all |
| `998094716164113` | `Sirah` client (stale row, 3.15) | both WhatsApp scopes | `target_ids` = `["351363664731426"]`, i.e. **not** the stored WABA | all three HTTP 400, code 100, subcode 33 | Stored WABA no longer in the token's scope |
| `351363664731426` | Sirah Digital | both WhatsApp scopes | `target_ids` = `["351363664731426"]` | all three HTTP 200; phone `391453774055149`: `CLOUD_API`, `is_on_biz_app` true, quality GREEN, `CONNECTED`, `code_verification_status` `NOT_VERIFIED`, 10 templates (all `nusi_*`, `APPROVED`), `messaging_limit_tier` `TIER_250` | Healthy |

All five are `SYSTEM_USER` tokens under app `Sirah CRM Wp` (app id `27135450269410430`). **The system user is per business portfolio, not per client**: the `Sirah` and `Sirah Digital` rows share user id `122106946323459883`; the demo, TNPSC and GV Mart tokens have different ids.

**Not yet run (5 of 10 connected WABAs, plus the `1649658386105751` probe).** Copy-pasteable, ordered by `sendability_registration_check_failed` count (all five are 0, so ordered by what needs answering first: Evokz is an open client problem, Brainlit is `sendable = false`):

```
557382370790751   # Evokz               (0 failures; open template-permission problem)
918537580543018   # Brainlit            (0; sendable=false)
392608088696144   # Fortune Innovatives (0)
1319892496787906  # Know Mind           (0)
463815720015046   # RD interblocks      (0)
```

Failure counts for the five already run: `998094716164113` 574, `1766605231203643` 124, `351363664731426` 1, `894384560175844` 0, `983390651411856` 0. For `1649658386105751` (no `wabas` row): `probe_waba.js --token-from 894384560175844 --target 1649658386105751` (3.10).

**Other results from the same session:**
- **Pairing check (TNPSC):** the stored phone `1222704867593433` belongs to the stored WABA; Meta returns it as `TNPSC Mentors`, `CLOUD_API`, quality `GREEN`, `CONNECTED`. The earlier "wrong WABA" diagnosis is withdrawn (1.1).
- **Authentication templates:** TNPSC's `signup_otp2` is `APPROVED`, category `AUTHENTICATION` (2.6).
- **`po_quote_request_doc_v3`:** both rows approved at Meta, ids `1435455455108429` and `1437829231531979`, `UTILITY` (3.2).
- **Coexistence:** the demo and TNPSC report `CLOUD_API` and `is_on_biz_app` false; stored data says 7 of 10 are true. **Confirmed live for one of those seven:** `is_on_biz_app` is `true` from Meta on `391453774055149` (Sirah Digital), matching the stored `registration_is_on_biz_app`. The stored and live values agree there, so the per-WABA live confirmation is lower priority than I said, but it is worth doing for the remaining WABAs in the same pass as the scope check (1.1, 5.2).
- **Messaging tier:** `messaging_limit_tier` absent on TNPSC, the demo and the stale row, present (`TIER_250`) on Sirah Digital. The field works; see 3.12.
- **`code_verification_status`:** `EXPIRED` on both numbers checked; benign on the evidence (3.12).

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

## Appendix D — investigation history and corrected figures (2026-10-12)

Three figures this document treated as established were artifacts. They are recorded here so they are not reintroduced.

| Figure once carried | What it actually was | Source of the correction |
|---|---|---|
| "55 of GV Mart's 66 sends failing" (was section 2.2; "55 of 66" in 1.2 and in Phase 0 item 0.1) | GV Mart's own test burst on 8 Oct to two of their own test numbers, self-diagnosed and self-fixed. **Not a Wasi failure rate** | GV Mart's own account, relayed by the project owner, 2026-10-12. The 66 rows were in GV Mart's own Supabase outbox, not Wasi's database |
| "95 non-test API key creations in the last 30 days" | A filter artifact: the test clients had been deleted, so a "not a test client" filter could not classify them. **Real figure: 11**, all with plausible labels (auto-created "CRM Integration" keys plus `tnpscmentors_auth`, `abs`, `NUSI`, `NUSI_AD`, `EI assessment`) | `audit_log` `api_key_created`, last 30 days, label-based classification, query run 2026-10-12 |
| "1,738 messages deleted" | The count of surviving `audit_log` rows (`actor_type='meta_webhook'`, `action='messages'`) for WABA `109558648723856`, 26 Aug to 4 Oct. These are webhook deliveries, a mix of inbound messages and status callbacks, not message rows. **The real number of deleted messages is UNKNOWN** | Same query: exactly 1,738 audit rows for that WABA id; no source for the original figure other than that match |

**Established (sources in 2.4):** deletion window 7 Oct 07:04:47 to 07:08:31 UTC (bounded by the password-reset audit row and the `contacts` autovacuum timestamp, corroborated by the unique-email re-creation at 07:09:54); the cascade chain from `pg_constraint`; the old WABA failing sendability checks since 5 Oct (`audit_log`); recovery closed by decision on 2026-10-12, not by exhaustion; autovacuum restored on 2026-10-12.

**Still open:** who issued the delete (nginx log review pending: the preserved logs were not available to the investigation when this was written); the deleted message count (unknown, and will stay unknown).

### Further corrections, 2026-10-12 (VPS session)

| Claim once carried | Status | Source |
|---|---|---|
| TNPSC's stored WABA `894384560175844` is wrong; Meta says `1649658386105751` owns the phone | **Withdrawn.** The stored WABA and phone pair correctly; the issue is scope targeting. What `1649658386105751` is remains open (it keyed 8 discarded webhooks and appears in the connect-time `wabaTargetIds`, which points to a WABA id rather than a portfolio id) | `diagnostic_scope_check.js` pairing check, via the VPS session; `wabas.connect_diagnostics`; `audit_log` |
| "One shared permission gap behind four clients" | **Three different causes** among the three WABAs run so far (healthy, scope-targeting, no scopes). Seven WABAs not yet run | Appendix A |
| "No client is on Coexistence" (proposed) | **Not supported.** `registration_is_on_biz_app` is true for 7 of 10 WABAs | `wabas` query, 2026-10-12 |
| "`messaging_limit_tier` is absent, so the refresh is broken" (proposed) | **Partly wrong.** The deprecated field returns `TIER_250` for five numbers; absent for four | `wabas.messaging_tier`, 2026-10-12; Meta messaging-limits page |
| "241 failed sendability rows on GV Mart" | **Not reproduced.** 123 on the current client, 47 on its deleted predecessor (170), 744 in all (573 of them on `Sirah`) | `audit_log` `sendability_registration_check_failed`, 2026-10-12 |
| "`Sirah` is a stale duplicate of `Sirah Digital`" (VPS session) | **Partly.** Two separate client rows, each with one WABA; the WABAs are different (`998094716164113`, display "Tnpsc Mentors", vs `351363664731426`, "Sirah Digital"). The stale one is dead for a real reason (the token's scope no longer includes it) and nothing real is attached to its client | `clients`, `wabas`, per-table counts, `audit_log`, 2026-10-12; VPS scope check |
| "Each client gets its own system user" | **Per business portfolio.** `Sirah` and `Sirah Digital` share user id `122106946323459883` | VPS scope check |
| "Our tier refresh treats an absent value as a failure" | **No.** Absence is stored as `'unknown'` with a fresh `checked_at`. The real bug is that a *failed call* never advances `checked_at`, so dead rows are re-probed hourly | `messagingTierRefreshRunner.js:42-48`, `sendabilityMonitorRunner.js` |
| "`messaging_limit_tier` is wrong" / "deprecated everywhere" | **Works on some numbers** (`TIER_250` on five); absent on four. Meta's page names a replacement field and says limits are per portfolio | `wabas.messaging_tier`, VPS output, Meta page |
| "573 failures = Sirah Digital's problem" | **The `Sirah` client's row.** Sirah Digital's own WABA has 1 failure (5 Oct) | `audit_log` |
| "573 audit rows from the stale row" (this document, 3.13 as first written) | **~1,650.** 574 `…check_failed` + 573 `sendability_unknown` + 503 `sendable_verdict_computed`; 573 was one of three counts | `audit_log`, 2026-10-12 |
| "The template-library refresh is broken for the whole platform, because `findAnyConnected` picks GV Mart's dead token" (proposed) | **Not supported.** The refresh succeeded on 8 Oct 08:02 UTC (25 entries, `last_refresh_error` null) with that selection in force. The selection is fragile, not currently failing; the next attempt is due 15 Oct 08:02 UTC | `meta_template_library_refresh_meta`, `meta_template_library_cache`, 2026-10-12 |
| "`998094716164113` is a stale duplicate of Sirah Digital" | **Withdrawn again, per the owner:** a real TNPSC-related WABA assigned to the `Sirah` client at onboarding (cross-client misassignment) | `wabas`, `audit_log`, owner's reading |
