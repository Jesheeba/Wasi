# Wasi AI Bot — Implementation Runbook

**Phases 0 and 1, broken into buildable units**
Date: 12 October 2026
Companion to `docs/ai-agent/SPEC.md` (`8c1e075`) and `docs/ai-agent/BUILD_PLAN.md` (`dc09907`)

---

## 0. What this document is

Three documents, three jobs. Do not mix them up.

| Document | Job |
|---|---|
| `SPEC.md` | **What** the agent is and why. Normative. The gate list, the refusal contract, the knowledge model. Read it before building. Do not redesign it. |
| `BUILD_PLAN.md` | **The backlog and the phases.** What else is broken, what order the phases go in, what is still open across the platform. |
| **This document** | **How to build Phase 0 and Phase 1.** Each unit has files, a schema change, write rules, the test that proves it, what breaks if it is wrong, and a prompt to paste. |

Every unit below is sized so one Claude Code session can land it and you can verify it before the next one starts. Do not batch them. The reason is in §1.3.

**Facts in this document carry their source.** Where a line number or a count appears, it was verified against the repository or the production database on 12 October 2026. Where something is unverified, it says so. If a session finds a fact here is wrong, the session is probably right — this document was written outside the repo.

> **Verified and corrected in-repo, 12 October 2026 (evening).** Every appendix fact and every unit was checked against the working tree, `pgmigrations`, and a read-only production query. Corrections are marked **[corrected]** or **[added]** inline; the full list is in the "Corrections log" after the appendix. Read the log first if you read nothing else. The file was moved from the repo root (`AI_FEATURE_IMPLEMENTATION.md`) to `docs/ai-agent/IMPLEMENTATION.md`, the path its own prompts use.

---

## 1. Before any code is written

### 1.1 Preconditions — hard gates

These are not suggestions. Each one, if skipped, makes a Phase 0 unit either unverifiable or actively harmful.

| # | Precondition | Why it blocks | Status 12 Oct (evening) |
|---|---|---|---|
| P1 | **Nightly `pg_dump` with a tested restore** | You currently have no backups (`"backups": []`, `pitr_enabled: false`). Phase 0 adds columns and backfills data. A bad backfill with no backup is unrecoverable, and 7 October already proved what that costs. | **NOT MET.** No backup tooling exists in the repo (no `pg_dump` script anywhere; `BUILD_PLAN` 4.2 is a spec only). The Management API result is from `BUILD_PLAN` 1.1 (re-verified there 12 Oct); I could not re-call it from this machine. |
| P2 | **`master` deployed** | Production runs `511ea49` (1 Oct). Building on top of an 11-day gap means you cannot tell whether a bug is yours or the gap's. Deploying also removes the fabricated Analytics chart, which must not survive into a release that adds AI features. | **NOT MET.** Live site still serves `Last-Modified: Thu, 01 Oct 2026 09:02:13 GMT` and `/design-system.css` still returns HTTP 500 (the bug fixed in `de4bdeb`). Note the deploy path is itself blocked by `BUILD_PLAN` 3.0 / 3.11 (`deploy.sh` has diverged on the VPS). |
| P3 | **The retry backoff fix (`BUILD_PLAN` 3.14)** | **[corrected]** Not a hard gate for unit 0.4. 3.14 fixes three *existing* runners (`sendabilityMonitorRunner`, `messagingTierRefreshRunner`, `metaTemplateLibraryRefreshRunner`). Unit 0.4 builds a *new* runner, and `SPEC.md` §6 already specifies its own `attempt_count` / `next_attempt_at` columns and the `forwardRunner` pattern, which already has a backoff schedule. The risk is a session copying the *wrong* runner, which §0.4 now prevents by naming the pattern. | **NOT BUILT** ("Spec, not built", `BUILD_PLAN` 3.14). Downgraded from gate to recommendation. Land it whenever; do not wait for it. |
| P4 | **GV Mart on a real, active client row with a working token** | Their current token holds `public_profile` only. **[Owner decision 12 Oct: NOT a gate on unit 0.5.]** The unit blocks `suspended` only, and 0 of 44 client rows are `suspended`, so it is a no-op today and cannot cut anyone off. P4 remains a gate on **`BUILD_PLAN` 3.5 (moving GV Mart)** and on any design that blocks non-`active` clients. These are two different things; do not conflate them again. | **NOT MET.** GV Mart client `4b09813e` is `pending_setup`, `payment_status` paid, 1 connected WABA. Token scope (`public_profile` only) is from `BUILD_PLAN` Appendix A (VPS, 12 Oct); cannot be re-checked locally because local cannot decrypt production tokens. |
| P5 | **Per-person admin accounts + the login audit deployed** (**NOT a gate**: owner decision 13 Oct, a high-priority backlog item, `BUILD_PLAN` 3.9) | Every unattributable finding in the 12 October investigation traces to one shared admin identity with no login audit. Phase 0 writes new data and changes send behaviour; you need to be able to say who did what. | **NOT MET.** `admin_users` has 1 row; 0 `admin_login_*` audit rows in production. The login-audit code is in the working tree only: `server/src/routes/adminAuth.js` is modified and uncommitted, `server/test/adminLoginAudit.test.js` is untracked. |
| P6 | **HARD PRECONDITION on Phase 1, ahead of every Phase 1 unit** (owner-accepted 12 Oct). See "P6 in detail" below. | `SPEC.md` §11, decisions 8, 9 and 24: customer messages leave Wasi's infrastructure for a model provider. **Shadow mode still does this.** "Nothing sends to the customer" is not "nothing leaves the database". Gate 1 requires `ai_consent_at`. The privacy policy is placeholder text and the Meta Tech Provider terms check is open. | **NOT MET.** Gates every Phase 1 unit (1.1 onward). Does not gate Phase 0, nor Phase 1 code written and tested against stubs. |
| S1 | **Migration ordering vs the Instagram branch** | `SPEC.md` decision 11 and this runbook's "next free number". | **RESOLVED 12 Oct (owner): next free number wins, no conflict** (`SPEC.md` decision 21). "Instagram lands first" is about release sequence, not integers; migrations need not be contiguous; the AI build does not wait for Instagram, which renumbers when it lands. Unit 0.1 took `086`; the next AI migration takes the next free number at that time (currently `087`). |

**P6 in detail (what it needs).** Three things must exist before any Phase 1 unit makes a model call on real client traffic: (1) a **privacy policy clause** (provider named, what is and is not sent, retention, training use, off unless the client turns it on; `SPEC.md` §11.1; the policy is placeholder text today); (2) a **recorded consent position per client** (who, when, which exact wording; `ai_agent_consent_events`), with shadow mode running for one client who has agreed first; (3) a **decision on whether clients must tell their own customers** that an AI processes their messages. **Item 3 is a legal question, not an engineering one, and so is the wording of item 1. It needs an actual lawyer, not our judgement.** Engineering must not guess at either. Also open: the Meta Tech Provider terms check on third-party processing (`SPEC.md` §11.3).

**What can start now.** Units 0.1, 0.2 and 0.3 as *code and tests*, committed locally, **one unit per session, reporting before the next**. Nothing is applied to the shared database: that is what P1 and P2 actually gate (migrations and backfills). Unit 0.4 is next in order after those. Unit 0.5 has no remaining gate (P4 dropped 12 Oct, P5 dropped 13 Oct); it adds no schema, so only P2 (deploy) stands between it and production. **Note:** `paymentReminderRunner` auto-suspends 5 days after an admin marks a client unpaid, so once 0.5 ships that suspension starts to bite (`BUILD_PLAN` 0.5). Phase 1 is held on P6.

**Status:** unit 0.1 built and committed locally (`a640571`), migration `086` and the backfill **not applied**.

P1 and P2 are a morning's work **[corrected: P2 is not; it is blocked on `BUILD_PLAN` 3.0 / 3.11]**. P3 is small and specified.

### 1.2 Standing constraints for every session

Paste these into every implementation prompt. They are not negotiable and they were all earned.

```
- Never print a secret value — password, hash, token, API key, app secret.
  Name the variable, the file and the commit.
- Never rewrite git history.
- Database writes only where the task explicitly authorises them. Reads use
  `begin read only` or `set local` — never session-level settings over
  DATABASE_URL, because the pooler leaks them between sessions.
- Never pre-assign a migration number. Take the next free one at
  implementation time. 081 and 082 exist only on feature/instagram-phase-1
  and are stranded below the highest applied number.
- Local development cannot decrypt production WABA tokens
  (utils/encryption.js derives the key from SERVER_SECRET). That is correct
  behaviour. Do not work around it. Anything needing a live Meta call runs
  on the VPS via `docker exec wasi-crm node ...` — the VPS host has no
  node_modules (a local checkout does).
- Do not touch wabasRepo.findByClientId or anything about multi-number
  support. That is a separate 1.5–3 week project.
- Do not push. The repository is still public.
```

### 1.3 Why one unit per session

Across nine days of this project, every attempt to move several things at once produced a report where the interesting finding was buried and the error was invisible. The sessions that caught real bugs — the gate 4 logic error, the `insertEcho` contradiction, the Coexistence figures, `findAnyConnected` — were the ones given a single, narrow question.

One unit, one session, one verification. Then the next.

### 1.4 Two sessions in one working tree (owner question, 13 Oct)

**Recommendation: yes. Put each concurrent session on its own git worktree and its own branch, and do it before unit 0.5.** Unit 0.4 was safe in the shared tree only because none of its files were dirty (checked before starting); that is luck, not a mechanism.

**What the shared tree risks.** The other session has uncommitted edits in `admin.js`, `onboarding.js`, `wabasRepo.js`, `app.js`, `adminAuth.js`, `alertRunner.js`, `clientNotifier.js`, `validate.js`, plus untracked `wabaDisconnectService.js`. What has kept us apart is one habit on my side: staging explicit paths, never `git add -A` or `commit -a`. Either session breaking that habit sweeps the other's half-finished work into a commit. A `git stash`, `git checkout .` or `git reset --hard` by either session destroys the other's uncommitted work with no undo. Unit 0.5 edits `messagingService.js` (`getSendableWaba`), which calls `wabasRepo.findByClientId`, a file the disconnect build is changing now.

**What it costs (about ten minutes once):**

| Step | Cost |
|---|---|
| `git worktree add ../wasi-ai-agent -b ai-agent` (from current `master`, which already holds the AI commits) | under a minute |
| `cp server/.env` into it (gitignored; it holds the shared database URL, so the existing shared-DB rules apply there too, no new exposure) | seconds |
| `npm ci` in `server/` inside the worktree | about 6 seconds (measured 13 Oct) |
| `npm ci` at the repo root, for the Playwright UI tests | not measured; only needed if a session runs UI tests |
| Confirm with one test file | about 10 seconds |
| **Per unit afterwards:** merge `ai-agent` back to `master` and re-run the touched tests | about 5 minutes |

**What it does not fix.** (1) The database is shared, so migration numbers are still allocated across both branches: take the next free number at the moment of writing, and whoever merges second renumbers. `088` is `ai_jobs`; the disconnect build has no migration yet. (2) Merge conflicts are deferred, not removed; they surface at merge time in `messagingService.js` and `wabasRepo.js` rather than as lost work. (3) Playwright tests that bind port 4000 still collide if run at once. (4) `CLAUDE.md`, `BUILD_PLAN.md` and `SPEC.md` are edited by both; those merges are textual and small.

**One hard rule from 13 Oct: never link `node_modules` into a worktree with a junction or symlink.** `git worktree remove --force` followed the junction and emptied the real `server/node_modules` (restored with `npm ci`). Run `npm ci` inside the worktree instead; at 6 seconds there is no reason to share it.

---

## 2. Phase 0 — foundations

Five units. Three of them are correctness fixes that earn their keep whether or not the agent ever ships.

Build order: **0.1 → 0.2 → 0.3 → 0.4 → 0.5**. 0.5 last, because it is the only one that can break a live client.

---

### Unit 0.1 — `chats.last_inbound_at`

**Goal.** Know, from the database, when a chat's 24-hour customer service window opened.

**Why it matters beyond the agent.** You cannot currently tell whether a chat's window is open. That is the gap behind every `session_window_closed` rejection being a surprise rather than a prediction. With this column, the window becomes checkable before the send instead of discovered after it. It is also the only one of the five that is safe to backfill.

**Files.**
- A migration (next free number, taken at implementation time)
- `server/src/repositories/chatsRepo.js` — `insertInbound`
- Any other path that creates an inbound message row. **Find them; do not assume `insertInbound` is the only one.**

**Schema.** Add `last_inbound_at timestamptz` to `chats`, nullable. No default.

**Write rule.** Set to the inbound message's own timestamp on every inbound message. Use the message's timestamp, not `now()` — a webhook can be delivered late or retried, and the window Meta enforces runs from when the customer sent, not when you processed it.

**[added] Findings from the repo, 12 Oct:**
- `chatsRepo.insertInbound` (`chatsRepo.js:207`) is the **only** production code path that inserts a `direction = 'in'` message. The other `insert into messages` sites are `insertOutboundPending`, `insertEcho` (both outbound) and the seed scripts (`seed.js`, `seedLandingDemo.js`). So there is no bypass.
- The customer's send time already arrives as `sentAt` and is stored as `messages.sent_at` (`coalesce($5, now())`). Use that value.
- The existing `update chats` in `insertInbound` runs **only when the insert returned a row** (`if (rows[0])`), so a redelivered webhook does not re-run it. Put the new column in that same statement.
- Use `greatest(coalesce(last_inbound_at, 'epoch'), $sentAt)`, not a bare assignment: two webhooks can be processed out of order, and a late older one must not move the window backwards.

**Backfill.** Safe. `messages` has **no `created_at` column [corrected]** (it has `sent_at` and `inserted_at`), so the query is `select max(sent_at) from messages where chat_id = ... and direction = 'in'` per chat. Production scale on 12 Oct: **2,232 chats, 5,152 inbound messages, 1,537 chats with at least one inbound message**, so 695 chats legitimately stay null. One statement is fine at this size; batching is optional. Report chats updated versus chats that exist, and **state that a null means "unknown", which gate 3 must treat as window closed**, not open.

**The test.** An inbound message sets the column to the message timestamp, not to `now()`. A second inbound advances it. An outbound does not touch it.

**What breaks if it is wrong.** Gate logic reads a stale or absent window and the agent either refuses everything or attempts sends that Meta rejects.

**Prompt:**

```
Implement unit 0.1 from docs/ai-agent/IMPLEMENTATION.md: chats.last_inbound_at.

Read docs/ai-agent/SPEC.md first for context. Do not redesign anything in it.

GOAL
Add chats.last_inbound_at (timestamptz, nullable, no default) and populate it
on every inbound message, using the MESSAGE's own timestamp — not now().
A webhook can arrive late or be retried, and Meta's 24-hour window runs from
when the customer sent.

BEFORE WRITING CODE
1. Find every code path that creates an inbound message row. I know about
   chatsRepo.insertInbound. Find the rest and list them with file and line.
   If any path bypasses insertInbound, say so — that changes the design.
2. Confirm which timestamp field on the inbound payload is the customer's
   send time, and what it is called by the time it reaches insertInbound.
3. Take the next free migration number. Do not pre-assign. 081 and 082 exist
   only on feature/instagram-phase-1 and are stranded.

THEN
- Write the migration, with a down migration.
- Write the column in every path found in step 1.
- Write the backfill as a separate, batched script — not inside the
  migration. It should be re-runnable and report chats updated vs chats
  total.
- Write tests: inbound sets it to the message timestamp; a second inbound
  advances it; an outbound does not touch it.

REPORT
- The paths you found in step 1, and whether any bypass insertInbound.
- The migration number you took and why it was free.
- Backfill results: chats updated, chats total, chats left null and why.
- Test output.

CONSTRAINTS
[paste §1.2]

Commit. Do not push.
```

---

### Unit 0.2 — `chats.last_agent_reply_at`

**Goal.** Know when a *human* last replied to a customer.

**This is the unit most likely to be built wrong.** The first draft of the spec had a bug here that would have made the agent silent on every chat touched by any automation. It was caught in review, not in testing, because testing would not have surfaced it.

**Files.**
- A migration (next free number)
- `server/src/routes/chats.js` — the human send path, and **only** that path. **[corrected]** There are **two** routes: `POST /:id/messages` (line 181) and `POST /:id/messages/:messageId/retry` (line 230). `POST /` (line 42) only creates a chat and sends nothing. Do **not** put the write in `messagingService.sendChatMessage` or `retryMessage`: both are shared by the flow engine, `automationEngine`, `broadcastRunner` and the Hub API, which is exactly the bug this unit exists to avoid. Write it in the route handler, after a successful send.

**Schema.** Add `last_agent_reply_at timestamptz` to `chats`, nullable, no default.

**Write rule — read this twice.**

Written **only** from the human send path in `server/src/routes/chats.js` (the two routes above).

Written **also** from `chatsRepo.insertEcho`, **but only when the echo is not Wasi's own outbound coming back.** Match on message id: if an outbound row already exists for that message id, skip the write.

Never written from:
- `flowRunner` / `flowEngine`
- `broadcastRunner`
- the Hub API (`apiV1Messages.js`)
- the agent itself
- any other runner

**Why `insertEcho` is in and not out.** An echo is a staff member replying from the WhatsApp Business app on their phone. `registration_is_on_biz_app` is **true for 7 of the 9 currently connected WABAs [corrected: it was 7 of 10 on the morning of 12 Oct; the `Sirah` row has since been set to `failed`]**. The client list in the earlier draft of this paragraph was not re-derived and is dropped; query it. So phone replies are the norm across the client base, not an edge case.

> **[added] This write is inert today, and unit 0.2 does not protect those clients.** The app is **not subscribed** to `smb_message_echoes` (`SPEC.md` decision 14; `BUILD_PLAN` 1.1). Production has **0** messages with `source = 'whatsapp_app'`, ever. So `last_agent_reply_at` will never move for a phone reply, the human-active gate (gate 4) cannot see the owner, and the only protection for those 7 clients is `schedule_mode = 'outside_hours'` (`SPEC.md` §10.5, mandatory for Coexistence). Build the echo write anyway so it works the moment the field is subscribed, but do not describe unit 0.2 as protecting Coexistence clients, and do not let anything enable `'always'` for them. Test 6 below can only be a synthetic-payload test until a real echo has been captured.

**How the message-id exclusion already works [corrected].** `chatsRepo.insertEcho` (`chatsRepo.js:259`) inserts with `on conflict (meta_message_id) do nothing` and returns `rows[0]` (null when the id already exists). So the exclusion is: write `last_agent_reply_at` **inside the existing `if (rows[0])` block**, and nowhere else. No second lookup is needed. One real gap to test for: an echo that arrives before Wasi has saved `meta_message_id` on its own just-sent outbound row would not conflict, would insert a duplicate row, and would count as human. Say so in the report if the session can reproduce it.

**Why the exclusion is required.** If Wasi's own API sends also echo back, writing blindly means the agent's reply marks a human as active, and the agent goes silent. Meta's documentation lists only the Business app and companion devices as echo sources, so this is defensive rather than load-bearing — but the cost of being wrong is the agent never replying at all, so build the exclusion regardless.

**Backfill.** **Do not backfill.** Historical message rows do not record whether a send was human or automated. Leave existing rows null and let them populate forward. A wrong backfill here silences the agent on every existing chat.

**The test.** This is the acceptance criterion and it must be explicit:
- A human send through `routes/chats.js` writes it
- A broadcast send does **not**
- A flow send does **not**
- A Hub API send does **not**
- An echo of a message Wasi already has does **not**
- An echo of a message Wasi does not have **does**

**What breaks if it is wrong.** Either the agent never replies (false positives on "human active"), or it replies over a human mid-conversation with a customer (false negatives). Both are visible to the client's customers.

**Prompt:**

```
Implement unit 0.2 from docs/ai-agent/IMPLEMENTATION.md:
chats.last_agent_reply_at.

Read docs/ai-agent/SPEC.md section 7 and the gate 4 definition first. This is
the unit where an earlier draft had a logic bug that would have silenced the
agent entirely, so the write rule matters more than the schema.

GOAL
Add chats.last_agent_reply_at (timestamptz, nullable, no default).

WRITE IT FROM EXACTLY TWO PLACES
1. The human send path in server/src/routes/chats.js.
2. chatsRepo.insertEcho, BUT ONLY when the echo is not Wasi's own outbound
   coming back — match on message id and skip if an outbound row for that id
   already exists.

NEVER WRITE IT FROM
flowRunner, flowEngine, broadcastRunner, the Hub API (apiV1Messages.js), the
agent itself, or any other runner.

WHY insertEcho IS INCLUDED
An echo is a staff member replying from the WhatsApp Business app.
registration_is_on_biz_app is true for 7 of 9 connected WABAs, so phone
replies are the main human reply path for most clients. BUT the app is not
subscribed to smb_message_echoes, so this write is inert in production until
it is (SPEC decision 14). Build it so it works then; do not claim it protects
anyone today. The routes in chats.js are POST /:id/messages AND the retry
route; write in the route handler, never in messagingService.

DO NOT BACKFILL. Historical rows cannot distinguish human from automated
sends, and a wrong backfill silences the agent on every existing chat. Leave
them null.

BEFORE WRITING CODE
1. Confirm the human send path in routes/chats.js is the ONLY route a human
   reply can leave through. If there is a second, name it — it changes the
   design.
2. Confirm how insertEcho receives the message id and whether an outbound
   row for the same id is findable at that point. If it is not, say so and
   propose how to make it so, rather than writing the field blindly.
3. Take the next free migration number.

TESTS — these are the acceptance criteria, all six must pass
- A human send through routes/chats.js writes it.
- A broadcast send does NOT.
- A flow send does NOT.
- A Hub API send does NOT.
- An echo of a message Wasi already has does NOT.
- An echo of a message Wasi does not have DOES.

REPORT
- Step 1 and 2 findings with file and line.
- The migration number.
- All six test results individually. Do not summarise them as "tests pass".

CONSTRAINTS
[paste §1.2]

Commit. Do not push.
```

---

### Unit 0.3 — `{handled, how}` from the automation engines

**Goal.** Let anything downstream know whether a flow or automation already handled a message.

**Why it matters beyond the agent.** Nothing can currently tell whether a flow matched. That is why automation behaviour cannot be audited, and why "did the bot answer this?" has no answer today.

**Files.**
- `flowEngine.evaluate`
- `automationEngine.evaluate`
- `server/src/routes/metaWebhook.js` — the flow call, line 260 (`await flowEngine.evaluate(pool, clientId, contact, chat, msg, body)`), inside a try/catch that logs and continues
- **Every other caller.** **[corrected]** Found: there is exactly **one** production caller of `flowEngine.evaluate` (`metaWebhook.js:260`) and exactly **one** of `automationEngine.evaluate` (`flowEngine.js:491`, at the end of `flowEngine.evaluate` itself). So `flowEngine.evaluate`'s return must be built from its own `continueFlow` / `captureReply` branches **plus** `automationEngine.evaluate`'s result. Tests that exercise these directly: `flowEngineRunToRest.test.js`, `flowEngineCaptureReplyEndToEnd.test.js`, `metaWebhookEchoRouting.test.js`; re-run them.

**Design.** Return `{ handled: boolean, how: string | null }`. `how` is a short identifier naming what handled it — a flow id, a node id, a rule name — for logging and later analytics. Not a sentence. **[added] Use the vocabulary and the `handled: true` branches in `SPEC.md` §7 (gate 5): `flow_continued`, `flow_capture_reply`, `rule_started_flow`, `rule_text_reply`. `unmatched_input` is `handled: false`** (decision 15: the agent stays silent anyway). **A thrown engine error is not `handled: false`.** The existing catch at `metaWebhook.js:262` must record it as `flow_error` (decision 18) so the agent stays silent *and* a rising rate is visible; collapsing it into `handled: false` would let the agent speak over a failing flow.

**The test.** A message that matches a flow returns `handled: true` with a non-null `how`. A message that matches nothing returns `handled: false`. Every existing caller still behaves identically.

**What breaks if it is wrong.** The agent replies to messages a flow already answered, and the customer gets two answers. Or a caller that expected the old return shape silently stops working.

**Prompt:**

```
Implement unit 0.3 from docs/ai-agent/IMPLEMENTATION.md: flowEngine.evaluate
and automationEngine.evaluate return {handled, how}.

GOAL
Both functions return { handled: boolean, how: string | null }. `how` is a
short identifier naming what handled the message — a flow id, node id or
rule name. Not a sentence.

BEFORE WRITING CODE — THIS IS THE RISKY PART
Find EVERY caller of flowEngine.evaluate and automationEngine.evaluate and
list them with file and line. I know about server/src/routes/metaWebhook.js
around line 260. Find the rest. Changing a return shape breaks every caller
that is not updated, and a missed one fails silently.

For each caller, say what it currently does with the return value and what it
will do with the new shape.

THEN
- Change both signatures.
- Update every caller found above.
- Tests: a matching message returns handled true with non-null how; a
  non-matching message returns handled false; every existing caller behaves
  identically to before.

REPORT
- The complete caller list with file and line, and what each does with the
  value.
- Whether any caller was relying on the old shape in a way that needed more
  than a mechanical change.
- Test output.

CONSTRAINTS
[paste §1.2]

Commit. Do not push.
```

---

### Unit 0.4 — `ai_jobs` and its runner

**[corrected] This does not wait for P3.** `BUILD_PLAN` 3.14 fixes three *other* runners. This unit is a *new* poller and must not copy the three that have the bug (`sendabilityMonitorRunner`, `messagingTierRefreshRunner`, `metaTemplateLibraryRefreshRunner`: only the success path advances `checked_at`, so a failing row is due every tick, forever, which produced ~1,650 audit rows from one dead WABA row). The pattern to copy is **`forwardRunner` + `webhookDeliveriesRepo`**, as `SPEC.md` §5/§6 already says: the row is leased at insert, claimed with the CTE `FOR UPDATE SKIP LOCKED` form, `attempt_count` / `next_attempt_at` advance on failure (backoff 1m→5m→30m→2h→6h), `attemptImmediately()` is fire-and-forget, and the 5-second tick is retry/fallback only. Do **not** use the `WHERE id IN (SELECT ... LIMIT)` claim form: `broadcastRecipientsRepo.claimBatch` had a real PG17 bug with it (CLAUDE.md, Known Gaps).

**Goal.** A durable queue of agent turns, processed by a runner that follows the existing pattern.

**Files.**
- A migration (next free number)
- A new runner, alongside `broadcastRunner`, `forwardRunner`, `flowRunner`, `alertRunner`
- Wherever runners are registered
- `metaWebhook.js`: the enqueue + `attemptImmediately()` call, **isolated in its own try/catch** after the flow engine returns `{handled: false}` (`SPEC.md` §5: an uncaught throw there makes Meta retry, and the retry skips the whole block because the message insert is idempotent)

**Schema.** An `ai_jobs` table. **[corrected]** Use the DDL in `SPEC.md` §6 (`ai_jobs`), which already has the required columns, a unique index on `inbound_message_id` (a redelivered webhook cannot enqueue twice) and a due index. It is platform-internal (runner uses the privileged `pool`), so no `wasi_app` grant; scope every query by `client_id`. Jobs older than the 24-hour window are marked `failed`, not retried.

**Requirements.**
- **Single-claim safety.** Two runners racing must not both process one job.
- **Reclaim on timeout.** A job claimed and not completed within a timeout becomes claimable again, or the first crash strands it forever.
- **Bounded retries with backoff**, per P3. Not infinite.
- **A terminal failed state** that does not retry.
- **No unbounded growth.** Either a retention policy or a cap.

**The test.** This is the one that needs real effort:
- A job can be enqueued
- Two concurrent runners claim it **exactly once**
- A job claimed and abandoned becomes reclaimable after the timeout
- A job that fails repeatedly reaches a terminal state and stops
- Audit rows are written on state transitions only, not on every attempt

**What breaks if it is wrong.** Duplicate agent replies to the same customer message, or jobs stranded invisibly, or the audit-row flood.

**If there is no way to test concurrent claiming today, say so.** Building that harness is part of this unit, not a reason to skip the test.

**Prompt:**

```
Implement unit 0.4 from docs/ai-agent/IMPLEMENTATION.md: the ai_jobs table
and its runner.

PATTERN — READ THIS FIRST
Copy forwardRunner + webhookDeliveriesRepo (SPEC.md sections 5 and 6), NOT
sendabilityMonitorRunner, messagingTierRefreshRunner or
metaTemplateLibraryRefreshRunner. Those three have the bug in BUILD_PLAN 3.14
(only the success path advances checked_at, so a failing row retries every
tick forever and wrote ~1,650 audit rows). forwardRunner already advances
attempt_count/next_attempt_at on failure. Use the CTE FOR UPDATE SKIP LOCKED
claim form, never WHERE id IN (SELECT ... LIMIT).

BEFORE WRITING CODE
1. Read forwardRunner.js and webhookDeliveriesRepo.js end to end and tell me
   how claiming, retrying, terminal states and audit writes are done today.
   Match that pattern. Do not invent a second one. Use the ai_jobs DDL from
   SPEC.md section 6.
2. Tell me whether a test harness exists that can exercise two concurrent
   runners against one job. If not, say so — building it is part of this
   unit.
3. Take the next free migration number.

REQUIREMENTS
- Single-claim safety: two runners must never both process one job.
- Reclaim on timeout: a job claimed and not completed within a timeout
  becomes claimable again, so one crash does not strand it forever.
- Bounded retries with backoff per 3.14. Not infinite.
- A terminal failed state that does not retry.
- No unbounded table growth — a retention policy or a cap.
- Audit rows on state transitions only, never per attempt.

TESTS — all five
- A job can be enqueued.
- Two concurrent runners claim it exactly once.
- A job claimed and abandoned becomes reclaimable after the timeout.
- A job failing repeatedly reaches a terminal state and stops retrying.
- Audit rows appear on transitions only.

REPORT
- The existing runner's pattern, as you found it.
- The migration number.
- Each test result individually.
- Anything about the existing pattern you think is wrong. Say it now.

CONSTRAINTS
[paste §1.2]

Commit. Do not push.
```


**Built 13 Oct 2026 (local commit, migration NOT applied).** `088_ai_jobs.js`, `aiJobsRepo.js`, `aiAgentRunner.js`, the webhook hand-off in `metaWebhook.js`, and a real-Postgres test harness (`test/support/embeddedPostgres.js`, about 10 seconds to boot and migrate; Postgres 18.x against production's 17.x, so it is evidence for the SQL's logic, not for 17-specific planner behaviour). What differs from the plan above:

- **3.14 was not a gate and had not landed** (see `BUILD_PLAN` 3.14). The queue copies `forwardRunner`, not the three buggy runners.
- **Retries are three, not five** (30 s, 2 min, 10 min): an answer to a customer's question is worth little hours later, and a handover is the fallback.
- **The attempt is counted at claim time**, so a worker that keeps dying cannot loop forever; a failed result is guarded by attempt number, so a slow worker whose lease expired cannot overwrite the live attempt.
- **The enqueue decision is `flowEngine.agentMayAnswer`**, never `!handled`. Today it enqueues nothing for anyone: the default `isEligible` returns false until unit 1.1 supplies the `ai_agents` lookup, and the poller only starts when `AI_AGENT_RUNNER_ENABLED=true`.
- **Handler is a placeholder** that throws; the pipeline (gates, prompt, model, send) is units 1.x. The runner is the queue, not the agent.
- **Audit:** retries are console lines (as in `forwardRunner`); exactly one `audit_log` row (`ai_job_failed`, actor `system`) per terminal failure.
- **Retention:** finished rows are purged after 7 days, checked hourly.
- **A job older than 24 hours is failed (`window_expired`)**, not retried.
- **No grant to `wasi_app`**, asserted by a test.

---

### Unit 0.5 — `clients.status` enforcement

**Product decision required before this ships (owner, 13 Oct): shipping it makes a client's sends stop five days after an admin marks them unpaid, with no person present that day, and the Wasi app shows no suspended indicator.** What the client experiences and the open questions are in `BUILD_PLAN` 0.5.

**No precondition gates this unit (owner decision 13 Oct). P5 (per-person admin accounts + login audit) was dropped as a gate and is a high-priority backlog item (`BUILD_PLAN` 3.9). P4 is not a gate on this unit** (owner decision 12 Oct, §1.1): it blocks `suspended` only and 0 clients are suspended, so it changes nothing today. P4 stays a gate on moving GV Mart (`BUILD_PLAN` 3.5), which is a different piece of work.

**The hazard, in numbers [corrected 12 Oct evening].** Of 14 non-test clients, **8 are `pending_setup`**, and **4 of those hold a connected WABA today** (5 on the morning of 12 Oct, before the `Sirah` row was set to `failed`). 6 are `active`, 5 of them with a connected WABA. **0 clients are `suspended`.** Enforcing "not active" naively blocks the pending_setup clients the moment they send, so a blanket gate on `status = 'active'` is not viable. Blocking `suspended` only changes nothing for any client today; its first effect will be on the next client suspended (note the payment-reminder feature auto-suspends at day 5 unpaid, so this will start to bite real clients the first time that fires).

**[corrected] The send path.** Every outbound client send goes through `messagingService.sendChatMessage` (chat routes, Hub API `apiV1Messages.js`, `broadcastRunner.js:174`, `flowEngine.js`, `automationEngine.js`) or `messagingService.retryMessage`; both call `getSendableWaba(clientId)`, so that is the single choke point. (CLAUDE.md's statement that `broadcastRunner` calls `metaClient.sendTemplateMessage` directly is stale.) The only other `metaClient.send*` callers are `alertNotifier.js` and `clientNotifier.js`, which send from the platform's own WABA; they are deliberately outside the gate, and must stay so, or a suspended client could never be told they are suspended.

**Goal.** A suspended client cannot send. Nothing else changes.

**Files.**
- `server/src/services/messagingService.js` — `sendChatMessage` and `getSendableWaba`

**Design.** Enforce at the **send path**, not the routes. There are several routes and one send path. Block on `suspended` specifically. Do not block `pending_setup` — that would cut off five live clients.

Return a clear error code consistent with the existing eight 409 codes (`waba_not_connected`, `consent_required`, `plan_limit_reached`, `session_window_closed`, `auth_code_required`, `auth_code_invalid`, `media_resolution_failed`, `conflict`). **[corrected source]** Seven are `MessagingError` codes in `messagingService.js`; `conflict` is not a send-path code at all, it comes from `apiV1ErrorHandler.js:29` (a Postgres unique violation). Any `MessagingError` other than `send_failed` is mapped to 409 by `apiV1Messages.js:115`, so a new code gets the 409 automatically. The retry-only code `not_failed` is not a Hub API code.

**And log the rejection.** `session_window_closed` is currently thrown in `messagingService.js` (lines 113 and 249) before any message row is created and is written nowhere — no `messages` row, no audit trail. A client can be rejected repeatedly and the database shows nothing. (The "63 times" in the earlier draft has no source and could not be reproduced; treat it as illustrative.) Do not add a ninth invisible rejection. **Recommendation (12 Oct): this unit carries its own logging; it does not wait for 3.6.** 3.6 is unbuilt and unscheduled, so waiting leaves this the one send rejection nobody can see for an unbounded time. Write one `audit_log` row per client per hour (action `send_rejected_client_suspended`, `actor_type` `system`, `target` the client id and the error code), throttled by an existence check on the last hour. **The throttle is mandatory**: a suspended client's integration can retry every second, and the unthrottled version is exactly the ~1,650-row flood of `BUILD_PLAN` 3.14. Do not widen this to `session_window_closed` in the same unit. When 3.6 lands it replaces this row rather than duplicating it.

**The test.**
- A suspended client's send fails with the documented code, through every send path
- A `pending_setup` client with a connected WABA can still send
- An active client is unaffected
- The rejection is recorded somewhere queryable

**What breaks if it is wrong.** Five live clients stop sending, or a suspended client keeps sending, or you add another rejection nobody can see.

**Prompt:**

```
Implement unit 0.5 from docs/ai-agent/IMPLEMENTATION.md: clients.status
enforcement.

PRECONDITIONS — CHECK BOTH, STOP IF EITHER FAILS
1. GV Mart must be on a real active client row with a working token. Their
   token currently holds public_profile only.
2. Confirm the current count of non-test clients by status. As of 12 Oct, 8
   of 14 were pending_setup and 5 of those held a connected WABA. If that is
   still true, enforcing status naively blocks five live clients.

GOAL
A SUSPENDED client cannot send. Nothing else changes.

DESIGN
- Enforce at the SEND PATH, not the routes. messagingService.sendChatMessage
  and getSendableWaba. There are several routes and one send path.
- Block on 'suspended' only. DO NOT block 'pending_setup' — real clients
  operate while pending_setup and five of them hold connected WABAs.
- Return an error code consistent with the existing eight 409 codes.

AND LOG THE REJECTION
session_window_closed is currently thrown before any message row is created
and recorded nowhere. Do not add a ninth invisible rejection. DECIDED: this
unit carries its own logging and does not wait for BUILD_PLAN 3.6. Write one
audit_log row per client per hour (action send_rejected_client_suspended,
actor_type system, target = client id + error code), throttled by an
existence check on the last hour. The throttle is mandatory: a retrying
integration must not flood audit_log (BUILD_PLAN 3.14). Do not extend it to
session_window_closed in this unit.

BEFORE WRITING CODE
Confirm no send path bypasses sendChatMessage and getSendableWaba. List every
send path and say which of the two it goes through. A bypass means the gate
does not hold.

TESTS
- A suspended client's send fails with the documented code, through EVERY
  send path.
- A pending_setup client with a connected WABA can still send.
- An active client is unaffected.
- The rejection is recorded somewhere queryable.

REPORT
- Current client counts by status.
- The complete send-path list.
- Your decision on rejection logging and the reasoning.
- Each test result.

CONSTRAINTS
[paste §1.2]

Commit. Do not push.
```

---

### Phase 0 — definition of done

All of these, demonstrated rather than asserted:

- [ ] Both columns exist and populate going forward
- [ ] `last_inbound_at` backfilled, with the count of chats updated versus total
- [ ] All six `last_agent_reply_at` write-rule tests pass, listed individually
- [ ] `last_agent_reply_at` is **not** backfilled
- [ ] Both engines return `{handled, how}` and every caller is updated, with the caller list recorded
- [ ] A job is claimed exactly once by one of two concurrent runners
- [ ] A failing job reaches a terminal state and stops
- [ ] A suspended client cannot send through any path
- [ ] A `pending_setup` client with a connected WABA still can
- [ ] Rejections are queryable

---

## 3. Phase 1 — single-turn reply, shadow mode

The agent runs, produces a reply, and **does not send it.** Drafts are stored and reviewed by a human.

> **HARD PRECONDITION P6 (§1.1), ahead of every unit in this phase.** No unit below may make a model call on real client traffic until the privacy policy clause, the per-client consent position, and the decision on whether clients must tell their own customers all exist. The last is a legal question and needs an actual lawyer. Units may be written and tested against stubs before then; they may not be pointed at real messages.

**Why shadow mode is not optional.** It produces a real evaluation set from real customer messages at zero risk to a client relationship. **[corrected]** "Zero risk to the relationship" is true; "zero risk" is not. Shadow mode still sends customer message text and the client's knowledge to a third-party model provider, so it needs the client's recorded consent and a truthful privacy policy first (P6, `SPEC.md` §11). Run it on one client who has agreed, not on every enabled client. The gate 4 bug would have been invisible in unit tests and obvious within a day of shadow traffic. Run it for a week on one client before anything sends.

Build order: **1.1 → 1.2 → 1.3 → 1.4 → 1.5**.

---

### Unit 1.1 — agent configuration

**Goal.** Per-client agent settings, with the knowledge cap enforced at write time.

**Schema.** **[corrected]** Use the DDL in `SPEC.md` §6, not the six-field list in the earlier draft of this unit. That list omitted fields the gates need: the business profile block (`business_name`, `business_type`, `description`, `areas_served`, `hours`, `languages`), `schedule_mode` / `timezone` / `staff_hours` (gate 1, and the **mandatory** protection for Coexistence clients, `SPEC.md` §10.5), `fallback_message` / `handover_message`, the meter (`monthly_cap`, `replies_used`, `period_start`, `cap_notified_at`), and `ai_consent_at` (gate 1). Also `ai_agent_consent_events` and the `chats` mute/cooldown/handover columns. Enabling must be `requireRole('Admin')` (Owner passes) server-side; `'always'` must be refused server-side for any WABA with `registration_is_on_biz_app` true or null. If the session wants to trim scope for shadow mode, it must say which SPEC fields it is deferring, not silently drop them.

**The cap.** `knowledge_tokens` is capped at **2,500 per client**, enforced when the knowledge is saved, not when it is used. A client who pastes 10,000 tokens gets a clear error at save time, not a silently truncated agent.

**Count tokens, do not estimate them.** A character-count heuristic will be wrong for Tamil and for mixed Tamil-English text, which is most of your traffic. Use a real tokeniser or the API's own count (`messages.count_tokens`). **[added]** This departs from `SPEC.md` §8.3, which specifies `ceil(chars / 3.5)`. The departure is deliberate and conservative, but `SPEC.md` says deviations belong in §19: record it there.

**Prompt:**

```
Implement unit 1.1 from docs/ai-agent/IMPLEMENTATION.md: agent configuration.

Read docs/ai-agent/SPEC.md for the configuration fields. Do not invent
fields it does not define, and do not omit ones it does.

GOAL
Per-client agent config: enabled flag, knowledge_md, knowledge_tokens, tone,
escalation rules, business hours.

THE CAP
knowledge_tokens is capped at 2,500 per client, enforced AT SAVE TIME, not at
use time. Over the cap is a clear error to the client, never a silent
truncation.

COUNT TOKENS, DO NOT ESTIMATE
A character heuristic will be wrong for Tamil and for mixed Tamil-English
text, which is most of Wasi's traffic. Use a real tokeniser or the API's own
count. Tell me which you used and test it against a Tamil sample, a
mixed-script sample and an English sample. Report the three counts.

BEFORE WRITING CODE
Take the next free migration number. Decide and justify whether this is a
new table or columns on an existing one.

TESTS
- Config saves and loads per client.
- Knowledge at exactly 2,500 tokens saves.
- Knowledge at 2,501 is rejected with a clear error.
- Token counts for Tamil, mixed and English samples are correct.

CONSTRAINTS
[paste §1.2]

Commit. Do not push.
```

---

### Unit 1.2 — `get_knowledge_for`

**Goal.** The seam that lets Phase 2 add retrieval without touching anything else.

```
get_knowledge_for(agent, message) -> string
# Phase 1: returns agent.knowledge_md, ignores the message.
# Phase 2: may retrieve.
# Nothing else in the pipeline knows which it is.
```

**Build the signature with `message` in it even though Phase 1 ignores it.** That is the entire point. Omit the parameter and Phase 2 becomes a refactor of every call site.

**Prompt:**

```
Implement unit 1.2 from docs/ai-agent/IMPLEMENTATION.md: get_knowledge_for.

GOAL
get_knowledge_for(agent, message) -> string

Phase 1 body: return agent.knowledge_md. Ignore the message argument
entirely.

KEEP THE message PARAMETER even though Phase 1 ignores it. That is the whole
purpose of this unit — Phase 2 adds retrieval by changing this function's
body and nothing else. Omit the parameter now and Phase 2 becomes a refactor
of every call site.

Document in the function itself that the argument is deliberately unused in
Phase 1, so nobody removes it as dead code.

TESTS
- Returns the client's knowledge_md.
- Returns the same result regardless of the message argument.
- Handles an agent with empty knowledge without throwing.

CONSTRAINTS
[paste §1.2]

Commit. Do not push.
```

---

### Unit 1.3 — the eight gates

**Goal.** All eight gates from `SPEC.md`, in spec order. **[corrected]** Gates 1–7 run before the model call; **gate 8 (answer in scope) is evaluated on the model's output**, so it cannot run before it. Gate 5 is enforced at the call site (a job is enqueued only when the flow engine returned `{handled: false}`), with a re-check for jobs that arrive another way. Gate 1 includes the consent check and the schedule check; gate 2 is two independent checks (`ai_muted`, `ai_cooldown_until`) that must log different reasons.

**Read the gate list from `SPEC.md`.** Do not take it from this document or from memory. There are eight, and gate 4 is the human-active gate — verified against the spec on 12 October.

Gate 4 depends on units 0.1 and 0.2. It cannot be built before them and cannot be tested without them.

**Every gate needs a test that proves it fires.** A gate that has never fired in a test is a gate you do not know you have.

**Prompt:**

```
Implement unit 1.3 from docs/ai-agent/IMPLEMENTATION.md: the eight gates.

READ THE GATE LIST FROM docs/ai-agent/SPEC.md. Do not take it from the
implementation runbook and do not work from memory. There are eight and gate
4 is the human-active gate.

GOAL
All eight gates, in spec order, evaluated before the model call and before
the send decision.

DEPENDENCIES
Gate 4 needs chats.last_inbound_at and chats.last_agent_reply_at from units
0.1 and 0.2. Confirm both exist and populate before building it.

BEFORE WRITING CODE
List all eight gates as the spec defines them, with what each one blocks and
what data it reads. If any gate needs data that does not exist yet, say so
rather than approximating it.

TESTS — one per gate, eight in total
Each gate must have a test that proves it FIRES, not just that it exists.
Report all eight individually. A gate with no firing test is a gate we do
not know we have.

REPORT
- The eight gates as the spec defines them.
- Any gate whose required data does not exist.
- Eight test results, listed separately.

CONSTRAINTS
[paste §1.2]

Commit. Do not push.
```

---

### Unit 1.4 — the model call and cost accounting

**Goal.** Call Claude Haiku 4.5, handle `NEEDS_HUMAN`, record cost.

**Model.** Claude Haiku 4.5. $1 per million input tokens, $5 per million output (verified against the API reference, 12 Oct). **[Decided 12 Oct (owner): keep Haiku 4.5 through Phase 1]**, so the shadow run produces a cost baseline against a fixed variable. Claude Haiku 5.5 (`claude-haiku-5-5`) is $0.10 / $0.50 per MTok for prompts up to 100K, roughly 10x cheaper, and rejects non-default sampling parameters (`SPEC.md` §9.5 pins `temperature` 0.3). It is **not** a footnote: it is evaluation task **E1, as soon as Phase 1 shadow provides a quality baseline** (§4 and `BUILD_PLAN` §7), because it changes the unit economics behind the add-on price. **Per-message cost assumptions may move by an order of magnitude.** A session must not switch models.

**No prompt caching (as built), but for a firmer reason than the earlier draft gave [corrected].** Cache writes cost 1.25× and reads 0.1×, with a 5-minute default TTL, which argues against caching sparse traffic. More decisive: **Haiku 4.5's minimum cacheable prefix is 4,096 tokens**, and `SPEC.md`'s own sizing (~300 rules and profile + up to 2,500 knowledge + ~200 conversation) is about 3,000 tokens, below it. A cache marker there silently does nothing (`cache_creation_input_tokens: 0`). So on Haiku 4.5 the SPEC §12 "cache hit ~₹0.22" row does not apply at these sizes; the real figure is the uncached ~₹0.33 model cost plus Meta. **This contradicts `SPEC.md` §12.2 ("Do not skip caching in v1")**, so record the decision in §19. Keep the prompt block order the SPEC defines (stable blocks first), which costs nothing and keeps caching available if the model or the knowledge size changes. Record `tokens_cached` on every reply so the hit rate is measurable rather than assumed.

**`NEEDS_HUMAN` is a success, not an error.** It routes the chat to a human and is logged separately from failures. Measure the refusal rate: a healthy agent refuses often at first, and the rate falling over time is the signal that knowledge is improving.

**`cost_paise` is an integer.** Never a float, never a currency type.

**Prompt:**

```
Implement unit 1.4 from docs/ai-agent/IMPLEMENTATION.md: the model call and
cost accounting.

Read docs/ai-agent/SPEC.md for the prompt structure and the NEEDS_HUMAN
contract.

MODEL
Claude Haiku 4.5. $1/MTok input, $5/MTok output.

NO cache_control markers. Haiku 4.5's minimum cacheable prefix is 4,096
tokens and this prompt is about 3,000, so a marker silently does nothing; and
on sparse traffic the 1.25x write would rarely be read back. Keep the SPEC
block order (stable blocks first) and record tokens_cached on every reply so
the hit rate is measured. This departs from SPEC 12.2: say so in your report
so it can be recorded in section 19.

NEEDS_HUMAN IS A SUCCESS PATH
It routes the chat to a human. Log it separately from errors, and make the
refusal rate queryable — it is the main quality signal in Phase 1.

COST
cost_paise as an INTEGER. Never a float, never a currency type. Record per
turn, attributed to the client, with input and output token counts stored
separately so the arithmetic can be checked by hand.

TESTS
- A normal turn produces a reply and a cost row.
- A NEEDS_HUMAN response is recorded as a refusal, not an error.
- An API error is recorded as an error, not a refusal.
- cost_paise matches a hand calculation for a known token count. Show the
  calculation.

REPORT
- Measured cost for ten real-shaped turns, and the hand check.
- Where the refusal rate can be queried from.

CONSTRAINTS
[paste §1.2]

Commit. Do not push.
```

---

### Unit 1.5 — shadow storage

**Goal.** Store what the agent *would* have sent, with enough context to judge it.

**Per turn, store:** the triggering message, the drafted reply or the refusal, which gates passed, which gate blocked if any, the knowledge used, input and output token counts, `cost_paise`, and latency.

**Nothing sends in Phase 1.** There is no send path in this unit. Confirm it.

**Prompt:**

```
Implement unit 1.5 from docs/ai-agent/IMPLEMENTATION.md: shadow storage.

GOAL
Store what the agent WOULD have sent. Nothing sends in Phase 1.

PER TURN, STORE
- the triggering message id
- the drafted reply, or the refusal
- which gates passed, and which gate blocked if any
- the knowledge used (or a hash of it, if storing it per turn is wasteful —
  tell me which you chose and why)
- input and output token counts
- cost_paise
- latency

CONFIRM THERE IS NO SEND PATH
Trace the code and tell me explicitly that no path from the agent reaches
messagingService.sendChatMessage or any Meta call. This is the safety
property of the whole phase.

ALSO BUILD
A way for a human to read the drafts — a simple admin view or a query I can
run. Shadow mode is worthless if reviewing 100 drafts is painful.

TESTS
- A turn produces a complete shadow row.
- A blocked turn records which gate blocked it.
- A refusal records as a refusal.
- No path sends anything.

CONSTRAINTS
[paste §1.2]

Commit. Do not push.
```

---

### Phase 1 — definition of done

- [ ] 100 real inbound messages through the pipeline, each with a stored draft or refusal
- [ ] Every one of the eight gates has fired at least once, in shadow or in a test
- [ ] Cost per turn measured and matching a hand calculation within 5%
- [ ] The refusal rate is known and queryable
- [ ] A human has read 50 drafts and recorded, per draft, whether it was send-worthy
- [ ] No code path can send

The 50-draft review is the gate to Phase 2. Without it you are guessing.

---

## 4. What comes after

Phase 2 is two sub-steps and they must not be merged.

**2a — suggested reply.** The draft appears in the inbox as a one-click suggestion. A human sends it, edits it, or discards it, and which of the three is recorded. This is the last cheap source of evaluation data, and it is a sellable feature on its own.

**2b — auto-send, one client.** Gates pass, the agent sends. Start with the client whose shadow results were best. A per-client kill switch that takes effect on the **next turn**, not the next deploy.

**Gate to 2b:** suggestion acceptance above 70% unedited over 100 suggestions.

Phases 3 and 4 are in `BUILD_PLAN.md` §9 and §10.

**Hard rule before 2b (owner, 12 Oct): the `smb_message_echoes` subscription must be live and verified first.** Verified means a real echo captured (an `audit_log` row for the field, and a `messages` row with `source = 'whatsapp_app'`). The agent must not go live on a Coexistence client while it is blind to phone replies. Unit 0.2 is built as designed because the design is right, but until that subscription exists its echo write is inert, and gate 4's only live protection for the 7 Coexistence clients is the `outside_hours` schedule (`SPEC.md` decision 23).

**E1, as soon as Phase 1 shadow provides a quality baseline (raised 13 Oct from "after Phase 1"): evaluate Claude Haiku 5.5** on the shadow set: cost per turn, what to do about `temperature` 0.3 (it rejects non-default sampling), whether quality and `NEEDS_HUMAN` behaviour hold, and whether its lower cache minimum makes caching engage. Per-message cost assumptions may move by an order of magnitude and with them the add-on's unit economics (`SPEC.md` decision 22).

**Two more Phase 2b entry criteria (owner, 13 Oct, both in `BUILD_PLAN` §8):** an automated echo must be distinguishable from a human one (an away/greeting message configured in the Business app may echo and silence the agent after every inbound; specified, not built; `SPEC.md` decision 26), and the gate-4 asymmetry governs every judgement call (`SPEC.md` decision 25).

**Meta's service-message fee is an OPEN QUESTION that blocks the pricing document (`BUILD_PLAN` 5.6, `SPEC.md` decision 27).** Every per-reply figure is unverified until Meta answers.

**Unit economics are UNRESOLVED (owner, 13 Oct).** At ~₹0.45 per reply the ₹1,499 tier cannot absorb unlimited AI replies (4,000 replies ~ ₹1,780). Four options are specified, with a breakdown of where the ~3,000 input tokens go, in `BUILD_PLAN` 5.5. Nothing is decided or built. Phase 1 must record per-turn token counts precisely enough to settle it: input and output tokens separately, and `knowledge_tokens` per client.

**Not during any AI phase:** multi-number support (`BUILD_PLAN` 3.7) or moving GV Mart off the demo client (3.5). Both touch the send path. Interleaving means neither lands and failures become impossible to attribute.

---

## 5. Verification log

Fill this in as units land. One row per unit. This is how you know where you are after a week away.

| Unit | Commit | Migration | Tests | Verified | Notes |
|---|---|---|---|---|---|
| 0.1 | `a640571` (local, not pushed) | `086_chats_last_inbound_at` (NOT applied) | 8 stub tests pass; real SQL, migration up/down/up and the backfill (dry run, batched apply, idempotent re-run) verified against a throwaway local Postgres | 12 Oct 2026 | Backfill script written, not run. Apply migration before deploying code. Null = unknown = window closed. |
| 0.2 | `7c0b739` (local, not pushed) | `087_chats_last_agent_reply_at` (NOT applied) | 17 stub tests: W1-W6 write-rule tests individually + non-fatal/409/source-scan/migration + 6 gate-4 null tests; mutation check (planted bug fails W2-W4 and the scan); real SQL, migration guard and missing-column path on a throwaway local Postgres | 13 Oct 2026 | Echo write inert until `smb_message_echoes` is subscribed. Human write is on ATTEMPT (before the send), not on delivery. Null polarity differs from `last_inbound_at`. Apply migration before code. |
| 0.3 | see `git log` (local, not pushed) | none | 17 outcome tests (O1-O11 + startFlow + evaluateSafely + agentMayAnswer allow-list + caller-list pin) + 2 router call-site tests; 4 mutation checks all caught | 13 Oct 2026 | No schema. Outcome table in `flowEngine.js`. Caller list: `metaWebhook.js:260`, `flowEngine.js:491`, `automationEngine.js:34`. `unmatched_input`, `flow_error` and `rule_*_failed` are non-answerable outcomes beyond SPEC's list; unit 0.4 must use `agentMayAnswer`, not `!handled`. |
| 0.4 | see `git log` (local, not pushed) | `088_ai_jobs` (NOT applied) | 13 on a real Postgres (J1 to J5 plus window expiry, purge, no-grant, down-guard) + 7 stub gating tests (E1 to E7) + 3 router hand-off tests; 9 mutation checks, all caught | 13 Oct 2026 | Runner off unless `AI_AGENT_RUNNER_ENABLED=true`; enqueues nothing until unit 1.1 supplies eligibility. 3.14 not landed and not needed. Apply migration before enabling. |
| 0.5 | | | | | |
| 1.1 | | | | | |
| 1.2 | | | | | |
| 1.3 | | | | | |
| 1.4 | | | | | |
| 1.5 | | | | | |

---

## Appendix — facts this document relies on

Each was re-checked on 12 October 2026 (evening). "Re-checked" below says by what. If a session finds one is wrong, the session is probably right — record the correction with its source.

| Fact | Source | Re-check result |
|---|---|---|
| Production runs `511ea49` (1 Oct); the VPS checkout is also at `511ea49` | `git log -1` in `/opt/wasi`; container created 2026-10-01 09:02:19 UTC | **Production half confirmed**: live site `Last-Modified` is 1 Oct 09:02:13 GMT, `/design-system.css` still 500. `511ea49` is in local history. **VPS checkout half not re-checkable from here** (no VPS access); rests on `BUILD_PLAN` 3.0. |
| `origin` is HTTPS with no credential helper | `git remote -v` on the VPS | **Remote URL confirmed** (`https://github.com/Jesheeba/Wasi.git`, same locally). **"No credential helper" is a VPS fact, not re-checkable here**; this machine uses Git Credential Manager (`manager`). Rests on `BUILD_PLAN` 3.0. |
| No backups: `"backups": []`, `pitr_enabled: false` | Supabase Management API, 12 Oct | **Not re-called** (no management token here). Matches `BUILD_PLAN` 1.1 and the 9 Oct memory note; no backup tooling exists in the repo. Note `walg_enabled: true` in `BUILD_PLAN`. |
| 7 of 10 connected WABAs have `registration_is_on_biz_app = true` | Database, 12 Oct | **Corrected: 7 of 9 connected** (2 false). There are 10 `wabas` rows; one is `failed` with null (the `Sirah` row, changed since the morning). Production query, read-only. |
| 8 of 14 non-test clients are `pending_setup`; 5 hold a connected WABA | Database, 12 Oct | **8 of 14 confirmed; "5" is now 4** (same cause). 6 `active`, 5 of them with a connected WABA. 44 client rows in total, 30 test. 0 `suspended`. |
| Eight gates; gate 4 is the human-active gate | `SPEC.md`, verified 12 Oct | **Confirmed** (§7 table rows 1–8; gate 4 "No human active"). |
| Eight 409 codes on `POST /api/v1/messages` | `apiV1Messages.js` / `validate.js` | **Count confirmed, source corrected**: seven `MessagingError` codes in `messagingService.js` + `conflict` from `apiV1ErrorHandler.js:29`. Nothing in `validate.js`. |
| `session_window_closed` is thrown pre-flight with no row created | `messagingService.js` | **Confirmed**: lines 113 (`sendChatMessage`) and 249 (`retryMessage`), both before any insert; the route catch only formats the response. |
| `audit_log` has no `detail` column | Database, 12 Oct | **Confirmed.** Columns: `id`, `actor_type`, `actor_id`, `action`, `target`, `created_at`, `actor_ip`. |
| `audit_log.actor_type` values in use: `meta_webhook`, `system`, `admin`, `client`; `actor_id` nullable | Database, 12 Oct | **Confirmed.** `actor_id` is null on `meta_webhook` and `system` rows, non-null on `admin` and `client`; the column itself is nullable. |
| Only the success path advances `checked_at`, so failing rows retry every tick | `messagingTierRefreshRunner.js:42-48` | **Confirmed**, line range approximate (the update is the success branch of `refreshOne`; the `catch` writes nothing). Same shape in the sendability and template-library runners per `BUILD_PLAN` 3.14. |
| 081/082 exist only on `feature/instagram-phase-1` | Repository, 12 Oct | **Confirmed** across all 8 local and remote refs; also no `pgmigrations` rows. Highest applied and on disk is `085`. |
| Local cannot decrypt production tokens; host has no `node_modules` | Verified on the VPS, 12 Oct | **First half is a documented standing gap** (CLAUDE.md `SERVER_SECRET`). **Second half corrected**: the *VPS* host has none; a local checkout has `server/node_modules`. |
| Haiku 4.5 at $1/$5 per MTok; caching writes 1.25×, reads 0.1× | Anthropic pricing | **Confirmed** against the API reference (default TTL 5 minutes). **Added**: Haiku 4.5's minimum cacheable prefix is 4,096 tokens; Haiku 5.5 is $0.10/$0.50. |
| *[added]* `messages` has no `created_at`; the customer's send time is `sent_at` | Production schema, `chatsRepo.insertInbound` | Confirmed. Unit 0.1's backfill SQL was wrong. |
| *[added]* `smb_message_echoes` not subscribed; 0 `messages.source = 'whatsapp_app'` | Production query; `SPEC.md` decision 14 | Confirmed 0 rows today. Subscription state itself not re-called. |
| *[added]* `admin_users` has 1 row; 0 `admin_login_*` audit rows | Production query | Confirmed. |

**Standing rule, inherited from `BUILD_PLAN.md`:** no figure enters this document without its source named. Four figures in the 12 October investigation — "55 of 66", "95 key creations", "1,738 deleted messages", "241 failures" — were all artifacts of counting something adjacent to the thing they were named after, and each one drove priorities for days before being checked.

---

## Corrections log (12 October 2026, evening pass)

1. **Wrong path.** The file was at the repo root; moved to `docs/ai-agent/IMPLEMENTATION.md`.
2. **Unit 0.1 backfill used `messages.created_at`, which does not exist.** Use `sent_at`. Added the `greatest()` write rule and the 695 chats that will stay null.
3. **Unit 0.2 overstated its protection.** The echo write is inert until `smb_message_echoes` is subscribed. Also: the human send path is two routes, not one, and the message-id exclusion is already given by `on conflict ... do nothing`.
4. **Unit 0.3 caller list answered**: one caller of each engine, `automationEngine` is called only from inside `flowEngine.evaluate`. Added the `flow_error` vs `handled: false` distinction from `SPEC.md` decision 18.
5. **P3 is not a gate for unit 0.4**, and the prompt let a session pick "any" runner, three of which have the bug. The prompt now names `forwardRunner` + `webhookDeliveriesRepo` and the SPEC §6 DDL.
6. **WABA and client counts moved** (7 of 9; 4 pending_setup clients with a connected WABA) because the `Sirah` row was set to `failed` after the morning's figures.
7. **Unit 0.5**: send-path list confirmed single choke point; the "eight 409 codes" attribution corrected; the unsourced "63 times" figure removed; noted that 0 clients are suspended today.
8. **Unit 1.1 field list was incomplete against `SPEC.md` §6** (no schedule, consent, profile, messages or meter). Pointed at the SPEC DDL. Token counting departs from SPEC §8.3: flagged for §19.
9. **Unit 1.3**: gate 8 cannot run before the model call.
10. **Unit 1.4**: "no caching" now rests on Haiku 4.5's 4,096-token cache minimum, which also makes `SPEC.md` §12's cache-hit cost row wrong at the SPEC's own prompt sizes. Contradicts SPEC §12.2: flagged for §19. Haiku 5.5 noted as an open decision, not adopted.
11. **Shadow mode is not "zero risk"**: it still sends customer text to a model provider. Added P6 (consent + privacy policy) and S1 (Instagram migration ordering, `SPEC.md` decision 11).
12. **Preconditions table now carries live status.** P1, P2, P4, P5, P6 are not met.

### Owner decisions, 12 October 2026 (after the evening pass)

13. **P6 is a hard precondition on Phase 1, ahead of every unit**, with its three needs and an explicit "needs an actual lawyer" flag on the customer-notification question and the policy wording. Recorded here, in `BUILD_PLAN` §7 and `SPEC.md` decision 24.
14. **Echo subscription must be live and verified before Phase 2b**, for any Coexistence client (`SPEC.md` decision 23, `BUILD_PLAN` §8).
15. **P4 dropped as a gate on unit 0.5**; it stays a gate on moving GV Mart (`BUILD_PLAN` 3.5). Rejection logging: carry its own, throttled (recommendation above).
16. **Migration order: next free number wins** (`SPEC.md` decision 21). Unit 0.1 took `086`.
17. **Caching and token counting departures recorded** with their reasons (`SPEC.md` decisions 19, 20), and `SPEC.md` §12's ~₹0.22 cache-hit figure corrected to ~₹0.45 uncached.
18. **Haiku 4.5 held through Phase 1; Haiku 5.5 is evaluation task E1 after it** (`SPEC.md` decision 22).
19. **Unit 0.1 built** and committed locally as `a640571`; migration and backfill not applied.
20. **P5 dropped as a gate on 0.5** (13 Oct). Correction recorded: `paymentReminderRunner` does auto-suspend (5 days after an admin marks unpaid), so 0.5 will bite on the first such client; 0 are marked unpaid today.
21. **Unit economics UNRESOLVED**, four options specified in `BUILD_PLAN` 5.5. E1 raised to "as soon as Phase 1 shadow provides a quality baseline".
22. **Unit 0.2 built** and committed locally as `7c0b739`; migration `087` not applied. Two behaviours worth knowing: the human write happens when a person *attempts* a reply (a failed or rejected send still means a person is working the chat; a false "human active" is the safe error), and `last_agent_reply_at` null reads as "no recent human reply" while `last_inbound_at` null reads as "window closed".
23. **Unit 0.3 built** (13 Oct): `{handled, how}` contract; `agentMayAnswer` is an allow-list (`SPEC.md` decision 28).
24. **Unit 0.4 built** (13 Oct): `ai_jobs` and the runner, on a real-Postgres harness. The owner's restated "3.14 must have landed" precondition conflicted with the accepted correction 5 (not a gate); proceeded on 5 and flagged it, since the unit does not inherit the buggy pattern.
25. **Worktrees recommended** before 0.5 (section 1.4).
