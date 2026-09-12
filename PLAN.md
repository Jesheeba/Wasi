# Gap Analysis & Build Plan — AiSensy Reference Spec vs. Wasi CRM

**Revision 3** — incorporates the three fixes and five answers below, on top of Revision 2's production-safety constraints and 9 corrections. No implementation code has been written; this is still Phase C planning only.

## What changed in Revision 3

1. **Item 8's down() guard replaced** — Revision 2's count-comparison guard was unsound (a user could add one tag and remove one backfilled tag, leave the counts matching, and the guard would wave through a rollback that drops real data). Replaced with an actual set-membership check: refuse if any `contact_tags` row has no matching `(contact_id, tag_id)` pair in `contacts.tag_id`.
2. **Item 5's first-response attribution rule made explicit** — the clock starts at the original inbound message's arrival, not at chat assignment; an automation reply in between does not reset or satisfy it. One-line justification and a concrete dedup mechanism (`chat_sla_logs.inbound_message_id`) added below.
3. **Item 2's backfill signal replaced, per your Answer 2** — confirmed by reading migration `003` and `chatsRepo.js` that `chats.last_message_at` exists and is genuinely kept current on both inbound (`insertInbound`) and outbound (`insertOutboundPending`) — so the column itself was never the problem. It's replaced anyway, per your instruction, with a more precise signal: a chat backfills to `resolved` unless it has an unanswered inbound message within the last 24 hours. Exact `UPDATE` rewritten below, and a `down()` guard added per your Answer 3.
4. **Answers 1, 4, 5 applied**: owner-only strictness in item 1 stays as drafted (Open Question 1 resolved, no change needed); payment-links stays owner-only (Open Question 4 resolved); build order confirmed with item 11 correctly placed before item 12 (Open Question 5 resolved).

Reference: `AISENSY_END_TO_END_ARCHITECTURE_AND_FLOWS.md` (a from-scratch blueprint: TypeScript, Redis/BullMQ, Next.js/React, Socket.io — none of which this repo uses). This codebase is plain CommonJS Express + Postgres, no build step, three vanilla-HTML/JS surfaces, Postgres-polling background runners instead of a queue broker. **Where the spec disagrees with this codebase, the codebase's stack, naming, and conventions win.** No renames, no new frameworks/ORM/queue, additive migrations only.

## Production safety — acknowledged, applies to Phase D too

This plan writes migration files; it does not run them. It writes route/service code; none of it will be exercised against production during planning or Phase D verification without your explicit go-ahead on each step. Two items below (13, 14) are explicitly scoped down for this reason — see their "Verify" sections. No plan item proposes a Meta write call (POST/PATCH/DELETE to `graph.facebook.com`), a production UPDATE/DELETE outside a migration file you'll run yourself, or a test WhatsApp send.

---

## What changed since Revision 1 (your 9 corrections + 5 answers)

1. **Item 6 (now item 1) redesigned** — see its new "Route-by-route role matrix" below. The fix is structural, not just a table: routers that should stay owner-only keep the existing `requireClientAuth` unchanged (which flatly rejects a `team_member`-typed token), rather than every router gaining team-member reachability by default.
2. **Item 3 (now item 8)** — added an explicit backfill `INSERT` (new-table-only, touches zero existing rows) copying `contacts.tag_id` into `contact_tags`. **Item 9's** tag condition now explicitly states it queries `contact_tags`, not `contacts.tag_id`.
3. **Item 7 (now item 2)** — added an explicit backfill rule for the new `status` column so 6 clients' full chat history doesn't dump into one live Unassigned queue.
4. **Item 15 (now item 16)** — redesigned around insert-first-let-the-constraint-reject, with a defined response for the caller that loses the race, and a staleness reclaim for an abandoned in-flight key.
5. **Item 10 (now item 5)** — first-response timing is now recorded only when the reply's actor is a team member, at the route layer, not inside the shared send service every caller (automation, broadcast, Hub API) goes through.
6. **Item 4 (now item 9)** — constraint name corrected to `broadcasts_audience_not_both` (verified by reading migration `039` in full — my Revision 1 name was wrong). Confirmed the "at most one" widening does **not** newly permit a zero-audience broadcast — that's pre-existing, intentional "everyone" behavior already documented in `039`'s own comment, not a bug introduced here.
7. **Item 2 (now item 7)** — casting strategy decided: validate against the attribute's declared type **at write time** (reject malformed input before it's ever stored), and cast **defensively** at query time (item 9) with a regex guard before any `::numeric`/`::date` cast, so no stored function is needed (this repo's migrations have never used one) and no legacy row can ever throw a query.
8. **Every migration below now states its down() behavior explicitly**, following the live-row-guard pattern already established in migrations `032`/`036`/`039`/`040`.
9. **Grep-verified**: broadcast pause/resume does **not** exist anywhere (`routes/broadcasts.js` only has `GET`/`POST`; `broadcastsRepo.listActive()` only ever matches `status = 'Sending'`; no code anywhere sets or checks a `'Paused'` status) — added as new item 11. The `message_template_status_update` webhook **does** exist and is fully handled (`metaWebhook.js`'s `handleTemplateStatusUpdate`, updates `message_templates.status`/`rejection_reason`, forwards the event) — added to the gap table as confirmed BUILT, no plan item needed.

**Your answers applied**: tenant-slug+email+password for team login (item 1); `contacts.tag_id` stays permanent, no breaking replace (item 8); flat AND/OR condition list, not nested groups (item 9); items 18–22 parked, not scoped further; build order is now **1 → 2,3,4,5 → 6,7,8,9,10 → 11,12,13,14,15,16**, with item 17 (Green Tick) parked and item 18 (flow nodes) left last; item 13 (messaging tier) ships as a migration only with the Graph API fetch left as a marked `// TODO` — no field name guessed; item 14 (CTWA) is built and tested against a simulated payload only.

---

## Phase B — Gap Analysis (unchanged from Revision 1 except the two rows below)

*(Full 45-row table from Revision 1 stands — see prior turn. Amendments:)*

| # | Spec capability | Status | Evidence |
|---|---|---|---|
| 46 | 3.5 / §10.1 Broadcast pause/resume | **MISSING** *(new finding)* | Verified by grep: `routes/broadcasts.js` has only `GET /` and `POST /`; `broadcastsRepo.listActive()` matches `status = 'Sending'` only; no code path anywhere sets or checks `'Paused'`. `broadcasts.status` has no DB `CHECK` (confirmed reading migration `003`), so this needs zero schema change — pure route + repo work. Build item 11. |
| 47 | §9.2 `message_template_status_update` webhook | **BUILT** *(confirmed, no plan item)* | `metaWebhook.js`'s `handleTemplateStatusUpdate` (dispatched via `WABA_SCOPED_FIELD_HANDLERS`) updates `message_templates.status`/`rejection_reason` and forwards the event to subscribers. |

---

## Phase C — Build Plan (reordered per your instruction)

Migration numbers continue from the real `043_clients_grant_onboarding_columns.js`, in this build order. Every new tenant table keeps the exact RLS/grant pattern from migrations `013`/`023`/`039`. Every migration below has an explicit `down()`; any down() that could destroy real client data by the time it's run gets the live-row-count guard already established in migrations `032`/`036`/`039`/`040` — refuse and report the count rather than silently drop.

---

### 1. Team member authentication & roles

**This is the foundation everything in group 2 depends on, and the item with the security fix you flagged. Full redesign below, not just a patched table.**

**The structural fix**: Revision 1's flaw was extending `requireClientAuth` itself to accept a `team_member` token, making every one of its 19 existing mount points reachable unless a route remembered to add a role check. Instead:

- `requireClientAuth` (`server/src/middleware/requireClientAuth.js`) is **left completely unchanged** — it continues to accept only `type: 'client'`. Every router that should stay owner-only simply keeps using it exactly as today, meaning a `team_member` token is rejected at the JWT-type check itself, before any role logic runs at all. Nothing needs to remember to block it — it structurally can't get through.
- A **new** middleware, `requireClientOrTeamAuth` (new file `server/src/middleware/requireClientOrTeamAuth.js`), accepts `type: 'client'` **or** `type: 'team_member'`. It sets `req.clientId` (the tenant id either way, so `withTenantContext`/RLS behave identically for both), plus new `req.actorType` (`'owner'|'team_member'`), `req.actorId`, `req.actorRole` (`'Owner'` for a client-type token, else the team member's `role`).
- A **new** middleware, `requireRole(...allowedRoles)` (new file `server/src/middleware/requireRole.js`), is applied **per route** (not once per router) wherever a `requireClientOrTeamAuth`-mounted router needs finer-than-router-level gating. `req.actorType === 'owner'` always passes regardless of the list (the client account itself is the ultimate authority on its own data). A `team_member` token passes only if `req.actorRole` is literally in the allowed list; otherwise `403`. **`requireRole()` called with zero arguments denies every team-member role** — the explicit fail-closed default for any route someone forgets to annotate.
- Only the 13 routers listed as "changed" in the table below swap `requireClientAuth` → `requireClientOrTeamAuth` in `app.js`. The other 6 tenant-scoped routers (`onboarding`, `billing`, `wallet`, `client-webhook`, `api-keys`, `payment-links`) are **not touched at all** — still `requireClientAuth`, still structurally owner-only.

**Design note, stated explicitly rather than silently decided**: in this v1 matrix, `Admin` and `Manager` team-member roles end up functionally **identical** everywhere, because the highest-blast-radius actions (WABA/Meta token settings, billing, wallet, API keys, client webhook secret, payment links) are kept **entirely owner-only** — not reachable by any team-member role, including one titled `Admin`. This is stricter than the reference spec's matrix (which lets `ADMIN` reach WABA settings). Given 6 live client accounts and the sensitivity of those actions (Meta token, payment credentials, integration secrets), defaulting stricter seemed safer than guessing you want a team-member "Admin" to have owner-equivalent reach — **see Open Question 1**.

#### Route-by-route role matrix (every mount in `app.js`, current + planned)

| `app.js` mount | Auth after this item | Team-member roles allowed | Notes |
|---|---|---|---|
| `/health` | none | N/A (public) | unchanged |
| `/api/auth` | self-applied per route | N/A | client (owner) login/register/me — unchanged |
| `/api/auth/team` *(new)* | none on login/accept-invite themselves | N/A | new router, issues the team-member JWT — see item 1's endpoints below |
| `/api/admin/auth` | admin JWT | N/A | Wasi internal staff, unrelated token type |
| `/api/contacts` | **→ requireClientOrTeamAuth** | GET/POST/PATCH: Admin, Manager, Agent. DELETE: Admin, Manager. | Agent can view/edit contacts while chatting, not delete them |
| `/api/chats` | **→ requireClientOrTeamAuth** | GET/POST/PATCH/messages/retry: Admin, Manager, Agent. DELETE (chat): Admin, Manager. `POST /:id/assign` to **self**: Admin, Manager, Agent. `POST /:id/assign` to **someone else**, `resolve`, `reopen`: Admin, Manager only. Notes (item 3): Admin, Manager, Agent. | Item 2/3's new sub-routes inherit this router's gating |
| `/api/tags` | **→ requireClientOrTeamAuth** | GET: Admin, Manager, Agent. POST (create tag): Admin, Manager. | |
| `/api/onboarding` | **unchanged** (`requireClientAuth`) | none — team token rejected outright | WABA settings / Meta token, owner-only |
| `/api/billing` | **unchanged** | none | owner-only |
| `/api/broadcasts` | **→ requireClientOrTeamAuth** | GET/POST/pause/resume: Admin, Manager. | Agent fully denied — "Launch Broadcast Campaign" per spec matrix |
| `/api/contact-lists` | **→ requireClientOrTeamAuth** | Admin, Manager. | feeds broadcast audiences |
| `/api/automation-rules` | **→ requireClientOrTeamAuth** | Admin, Manager. | bot/automation config |
| `/api/automation-flows` | **→ requireClientOrTeamAuth** | Admin, Manager. | flow builder config |
| `/api/templates` | **→ requireClientOrTeamAuth** | GET: Admin, Manager, Agent. POST/PUT/DELETE/sync: Admin, Manager. | Agent needs to pick a template when the 24h window is closed, not create/delete one |
| `/api/support-tickets` | **→ requireClientOrTeamAuth** | GET/POST: Admin, Manager, Agent. | |
| `/api/analytics` | **→ requireClientOrTeamAuth** | Admin, Manager. | Agent denied — matches spec's matrix exactly; item 5's new `/sla` sub-route inherits this |
| `/api/team-members` | **→ requireClientOrTeamAuth** | GET: Admin, Manager, Agent. POST (invite)/DELETE: Admin, Manager. | |
| `/api/contact-attributes` | **→ requireClientOrTeamAuth** | GET: Admin, Manager, Agent. POST/DELETE (definitions): Admin, Manager. | item 7's value endpoints are mounted under `/api/contacts/:id/attributes`, so they inherit the Contacts row above (Admin, Manager, Agent) |
| `/api/payment-links` | **unchanged** | none | financial — kept owner-only, **flagged in Open Questions** since the spec doesn't explicitly cover this one |
| `/api/wallet` | **unchanged** | none | financial, owner-only |
| `/api/client-webhook` | **unchanged** | none | integration secret, owner-only |
| `/api/api-keys` | **unchanged** | none | Hub API credentials, owner-only |
| `/api/template-library` | **→ requireClientOrTeamAuth** | Admin, Manager. | feeds template creation, same gate |
| `/api/canned-responses` *(new, item 4)* | requireClientOrTeamAuth | GET: Admin, Manager, Agent. POST/DELETE: Admin, Manager. | |
| `/webhooks/meta/data-deletion`, `/webhooks/meta`, `/webhooks/razorpay` | none (server-to-server) | N/A | no JWT of any kind on these |
| `/api/clients`, `/api/admin` | `requireAdminAuth()` | N/A | Wasi internal staff only, different JWT type entirely |
| `/api/v1/*` (6 routers) | `requireApiKey` | N/A | raw API key, not a JWT at all — a team-member token isn't even the right credential shape here |

- **Files touched**: `server/src/middleware/requireClientOrTeamAuth.js` (new), `server/src/middleware/requireRole.js` (new), `server/src/utils/auth.js` (new `signTeamMemberToken`), `server/src/routes/authTeam.js` (new), `server/src/routes/teamMembers.js` (invite endpoint), `server/src/repositories/teamMembersRepo.js` (password/login methods), `server/src/app.js` (swap 13 router mounts as tabled above, add `/api/auth/team`), every one of the 13 changed route files (add `requireRole(...)` per route).
- **Schema** — `056_team_member_auth.js`:
  ```sql
  ALTER TABLE team_members
    ADD COLUMN password_hash text,
    ADD COLUMN last_login_at timestamptz;
  ALTER TABLE team_members DROP CONSTRAINT IF EXISTS team_members_role_check;
  ALTER TABLE team_members ADD CONSTRAINT team_members_role_check
    CHECK (role IN ('Admin','Manager','Agent'));
  -- existing rows already default role='Agent' (migration 011) — this CHECK
  -- does not reject any existing row, confirmed by the default itself.
  ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_purpose_check;
  ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_purpose_check
    CHECK (purpose IN ('password_reset','email_verification','team_invite'));
  ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_subject_type_check;
  ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_subject_type_check
    CHECK (subject_type IN ('client','admin','team_member'));
  ```
  **down()**: drop the two widened CHECKs and restore the originals (safe, no data loss); for `team_members`, only drop `password_hash`/`last_login_at`/the new role CHECK if **no** `team_members` row has a non-null `password_hash` yet (live-row guard — once a real team member has set a password, rolling back would silently delete their credential) — else raise and report the count, same discipline as migration `039`'s down().
- **Endpoints**:
  - `POST /api/team-members/:id/invite` (Admin, Manager) → generates a `team_invite` token via `auth_tokens`, emails it. `200 { "invited": true }`.
  - `POST /api/auth/team/accept-invite` body `{ "token": "...", "password": "..." }` (no auth) → sets `password_hash`, flips `status: 'active'`. `200 { "token": "<jwt>" }`.
  - `POST /api/auth/team/login` body `{ "tenantSlug": "...", "email": "...", "password": "..." }` (no auth) → `200 { "token": "<jwt>", "teamMember": {"id", "name", "role"} }`; `401` on any mismatch (generic message, no user-enumeration).
  - JWT payload: `{ type: 'team_member', sub: teamMemberId, clientId, role }`.
- **Verify**: invite → accept-invite → login → hit `GET /api/contacts` with the team JWT, confirm correct tenant isolation (identical RLS behavior to the owner); confirm an `Agent`-role token gets `403` on `POST /api/templates` and on `POST /api/broadcasts`; confirm the SAME `Agent`/`Admin` token also gets `403` — via `requireClientAuth`'s own **unchanged, pre-existing** "Wrong token type" branch, not a role check — on `GET /api/onboarding/whatsapp/status`, `GET /api/billing/subscription`, `GET /api/wallet`, `GET /api/api-keys`, `GET /api/client-webhook`, `GET /api/payment-links` (corrected from an earlier draft of this plan, which wrongly expected `401` there — verified directly against `requireClientAuth.js`'s real code, not assumed). Pass: new `server/test/teamMemberAuth.test.js` green, **plus the full existing suite** (`node --test`) still green — this item has the largest blast radius in the plan.

---

### 2. Chat assignment + open/resolved status

**Depends on**: item 1.

- **What**: give `chats` the `assigned_team_member_id` and `status` columns the whole Unassigned/Mine/All/Resolved queue model needs — today neither exists.
- **The backfill problem you flagged**: a bare `ADD COLUMN status ... DEFAULT 'open'` puts every one of 6 clients' entire historical chat rows into a live `open`+unassigned queue at once.
- **`chats.last_message_at` confirmed, per your point 3**: read `server/src/db/migrations/003_tenant_tables.js` directly — `last_message_at timestamptz NOT NULL DEFAULT now()` (line 34), indexed `(client_id, last_message_at)`. Read `server/src/repositories/chatsRepo.js` directly — it's genuinely kept current on **both** directions: `insertOutboundPending` (line 123, `update chats set last_message_at = now()...`) and `insertInbound` (line 163, same). So the column exists and is maintained correctly; it was never the actual problem.
- **Backfill rule, per your Answer 2 (replaces Revision 2's 7-day-since-`last_message_at` rule)**: backfill a chat to `status = 'resolved'` **unless** it has an unanswered inbound message within the last 24 hours — i.e., the chat's most recent inbound message (`direction = 'in'`) both (a) arrived within the last 24 hours, and (b) has no outbound message (`direction = 'out'`) sent after it. This matches what an agent actually needs to triage on day one (an open question waiting on them) rather than depending on each client's own conversation cadence, which the 7-day rule did.
- `assigned_team_member_id` stays `NULL` for every historical chat (no historical assignment data exists to backfill from) — expected, not a bug: because the backfill above already moves every already-answered or stale chat out of the `open` queue, only genuinely-unanswered-in-the-last-24h chats appear in the initial Unassigned queue for agents to triage.
- **Files touched**: `server/src/routes/chats.js` (assign/unassign/resolve/reopen actions, extend list filters — with `requireRole` per item 1's table), `server/src/repositories/chatsRepo.js`.
- **Schema** — `045_chat_assignment_status.js`:
  ```sql
  ALTER TABLE chats
    ADD COLUMN assigned_team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
    ADD COLUMN status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved'));
  CREATE INDEX idx_chats_assigned ON chats(client_id, assigned_team_member_id);
  CREATE INDEX idx_chats_status ON chats(client_id, status);

  -- Backfill: don't dump 6 clients' entire chat history into one live
  -- Unassigned/Open queue. A chat only stays 'open' if it has a genuinely
  -- unanswered inbound message from the last 24 hours — everything else
  -- (already replied to, or stale) backfills to 'resolved'.
  UPDATE chats c
  SET status = 'resolved'
  WHERE NOT EXISTS (
    SELECT 1 FROM messages m_in
    WHERE m_in.chat_id = c.id
      AND m_in.direction = 'in'
      AND m_in.sent_at > now() - interval '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM messages m_out
        WHERE m_out.chat_id = c.id
          AND m_out.direction = 'out'
          AND m_out.sent_at >= m_in.sent_at
      )
  );
  ```
  **`>=`, not a strict `>`, found live during item 2's own implementation**: `seed.js` inserts an 'in' then 'out' message for each demo chat inside one transaction, and Postgres's `now()` is fixed for an entire transaction — both landed with the identical `sent_at`, and a strict `>` wrongly left every demo chat marked as still-unanswered. `>=` correctly counts a reply at or after the inbound's own timestamp as addressing it. Verified by re-running the migration against the local demo data and confirming the expected `resolved` status.
  **down()**, per your Answer 3: refuse the rollback if any chat has a non-default `status` (i.e., any `status <> 'open'`) or a non-null `assigned_team_member_id` — consistency with every other new migration's live-row guard, even though this means a rollback is very likely to be refused almost immediately after real use begins:
  ```sql
  -- down() guard
  SELECT count(*)::int FROM chats WHERE status <> 'open' OR assigned_team_member_id IS NOT NULL;
  -- if > 0: raise and report the count, same discipline as migrations 032/036/039/040
  ```
- **Endpoints**: `POST /api/chats/:id/assign {"teamMemberId": "..."}`, `POST /api/chats/:id/unassign`, `POST /api/chats/:id/resolve`, `POST /api/chats/:id/reopen`, extend `GET /api/chats?status=open&assignedTo=me|unassigned|<teamMemberId>`.
- **Verify**: run the backfill against a schema-shaped test fixture seeded with chats in each of the three cases (unanswered inbound within 24h, answered inbound, inbound older than 24h with no reply), confirm only the first case stays `open`; assign a chat, `?assignedTo=me` (as that team member) returns it; resolve it, confirm it drops out of the `open` filter. Pass: `server/test/chatAssignment.test.js` green.

---

### 3. Internal notes with @mention

**Depends on**: item 1.

- **What**: a per-chat internal note thread, visible only to team members, never sent to the customer.
- **Files touched**: new `server/src/repositories/chatNotesRepo.js`, `server/src/routes/chats.js` (new sub-routes, `requireRole(['Admin','Manager','Agent'])` per item 1's table).
- **Schema** — `057_chat_notes.js`:
  ```sql
  CREATE TABLE chat_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    author_team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
    body text NOT NULL,
    mentioned_team_member_ids uuid[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- grant select, insert, update, delete on chat_notes to wasi_app; enable+force RLS; tenant_isolation policy — matching migration 013's pattern exactly
  ```
  **down()**: guard — refuse if any `chat_notes` row exists (real internal notes a client's team wrote are not disposable), matching the `032`/`036` discipline.
- **Endpoints**: `GET /api/chats/:id/notes`, `POST /api/chats/:id/notes {"body": "...", "mentions": ["<teamMemberId>"]}`.
- **Scoped limitation, stated up front**: no push notification for a mention in v1 — a mentioned member sees it next time they poll/open that chat, matching this app's existing polling-only chat model (item 19, parked, is where "real-time" as a whole gets decided).
- **Verify**: post a note mentioning a team member, confirm it's returned with the mention resolved to a name and never appears in the customer-facing `GET /:id/messages`.

---

### 4. Canned responses (`/slash` commands)

**Depends on**: item 1 (for role gating; the feature itself doesn't need chat assignment).

- **What**: reusable shortcut → message-body snippets, autocompleted in the chat input on typing `/`.
- **Files touched**: new `server/src/repositories/cannedResponsesRepo.js`, new `server/src/routes/cannedResponses.js`, `server/src/app.js` (new mount, `requireClientOrTeamAuth`), root `app.js` chat-input autocomplete (frontend only).
- **Schema** — `058_canned_responses.js`:
  ```sql
  CREATE TABLE canned_responses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    shortcut text NOT NULL,
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(client_id, shortcut)
  );
  -- grant + RLS, same pattern
  ```
  **down()**: guard — refuse if any row exists (a client's real saved shortcuts).
- **Endpoints**: `GET /api/canned-responses`, `POST /api/canned-responses {"shortcut": "/refund", "body": "..."}` (Admin, Manager), `DELETE /api/canned-responses/:id` (Admin, Manager).
- **Verify**: create `/refund`, type it in a real browser's chat input, confirm autocomplete suggests and inserts the body; confirm an `Agent`-role token can `GET` but gets `403` on `POST`.

---

### 5. SLA / First Response Time tracking

**Depends on**: item 2.

- **What**: record first-response and resolution latency per chat/team-member.
- **The attribution fix you flagged (who gets credited)**: first-response timing is recorded **only** at the one call site that's genuinely a team-member-authored reply — `routes/chats.js`'s `POST /:id/messages` handler — and **only** when `req.actorType === 'team_member'` (or `'owner'`, since the owner can also personally reply). It is **not** recorded inside `messagingService.sendChatMessage` itself, because that shared function is also called by `flowEngine.js` (automation), `broadcastRunner.js` (campaigns), and `apiV1Messages.js` (Hub API) — none of those are a team member responding, and crediting them would inflate/fabricate agent performance metrics. This is a route-layer concern, not a service-layer one, by design.
- **The attribution rule you flagged as undefined (what the clock measures)**: when a flow or broadcast has already sent an automated outbound reply to an unanswered inbound, and a team member replies later, `first_response_seconds` is measured **from the original inbound's arrival to the first team-member reply** — **time since the original inbound, not time since the automated reply** — and an automated reply in between neither resets nor satisfies the clock. **The clock starts at inbound arrival, not at chat assignment.**
  - **Why time-since-inbound, not time-since-automated-reply**: item 5 already excludes automation from being credited as a "response" for SLA purposes, precisely because the business wants to measure real human responsiveness. If an automated reply reset the clock, a bot firing first would quietly mask a slow agent every time — the metric would stop measuring what it's named for.
  - **Why inbound arrival, not assignment**: assignment is internal routing, invisible to the customer. Starting the clock there would hide real queueing delay (time the chat sat unassigned) from a metric that exists specifically to surface delay the customer actually experienced.
  - **Dedup mechanism**: `chat_sla_logs` gets a new `inbound_message_id` column (below). On a team-member reply, the route finds the chat's most recent inbound message; if a `chat_sla_logs` row already exists for `(chat_id, inbound_message_id)`, this reply is not the *first* team-member reply to that inbound (a previous team-member reply already claimed the record) and nothing new is recorded. If no such row exists, one is inserted with `first_response_seconds = now() - inbound.sent_at`. This works regardless of how many automated replies fired in between, since only the team-member route ever writes to this table.
- **Files touched**: `server/src/routes/chats.js` (record on outbound reply, guarded by `actorType`; record on `resolve`), `server/src/repositories/chatsRepo.js` (new `findLastInboundMessage`), new `server/src/repositories/chatSlaLogsRepo.js`, new `GET /api/analytics/sla` sub-route.
- **Schema** — `059_chat_sla_logs.js`:
  ```sql
  CREATE TABLE chat_sla_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    team_member_id uuid REFERENCES team_members(id) ON DELETE SET NULL,
    inbound_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
    first_response_seconds integer,
    resolved_seconds integer,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX chat_sla_logs_one_per_inbound ON chat_sla_logs(chat_id, inbound_message_id) WHERE inbound_message_id IS NOT NULL;
  -- grant + RLS
  ```
  **down()**: guard — refuse if any row exists (real, historical agent-performance data).
- **Endpoint**: `GET /api/analytics/sla?since=...` (Admin, Manager only, per item 1's Analytics row) → `{ "byTeamMember": [{"teamMemberId": "...", "avgFirstResponseSeconds": 142, "avgResolutionSeconds": 3800}] }`. `team_member_id: null` rows (owner replies, or replies before item 1 shipped) are aggregated separately, not silently mixed into a named agent's average.
- **Verify**: simulate an inbound message then a team-member outbound reply N seconds later (via the route, with a real `team_member` JWT), confirm `first_response_seconds` recorded against that inbound's id; simulate the same sequence but with the reply coming from `flowEngine`/`broadcastRunner`/Hub API instead, confirm **nothing** is recorded; simulate inbound → automated reply → team-member reply, confirm `first_response_seconds` is measured from the *inbound*, not from the automated reply's timestamp; simulate two team-member replies to the same unanswered inbound, confirm only the first is recorded (unique index holds). Pass: `server/test/chatSlaLogs.test.js` green, explicitly covering all four cases above.

---

### 5.5. Combined UI pass for items 1–5

**Added after item 5 shipped, per an explicit scope decision — not renumbering anything else in this file.** Items 1–5 (team login/invite, chat assign/resolve/reopen, internal notes, canned responses, SLA tracking) were built backend-only, by design: building each one's frontend separately would mean touching the same inbox view five separate times. This item is that UI pass, done once, covering all five together, on the real `index.html`/`app.js` inbox surface (the 3-column Chat view). **From item 6 onward, frontend ships alongside each item, not deferred** — this is the one deliberate exception, not the new pattern.

- **What it covers, concretely**:
  - Item 1: a team-member login screen (tenant slug + email + password) and an accept-invite page (`marketing/accept-team-invite.html`, referenced by `routes/teamMembers.js`'s invite email but never built) — distinct from the existing owner login.
  - Item 2: assign/unassign/resolve/reopen controls on each chat row and in the open thread, plus the queue filter tabs (Unassigned/Mine/All/Resolved) driving `GET /api/chats`'s `status`/`assignedTo` params.
  - Item 3: an internal-notes panel in the chat detail column, with `@mention` autocomplete against the client's real team roster.
  - Item 4: `/` autocomplete in the chat message composer against `GET /api/canned-responses`.
  - Item 5: nothing customer-visible — `GET /api/analytics/sla` surfaced as a new Reports sub-view, Admin/Manager-visible only, matching item 5's own access gate.
- **Files touched**: `index.html`, `app.js`, `index.css` (root CRM app — the existing 3-column Chat view + Settings/Reports areas), new `marketing/accept-team-invite.html` + a small script for it, mirroring `marketing/reset-password.html`'s existing pattern.
- **Schema/migration**: none — this item is pure frontend, wiring already-shipped backend endpoints.
- **Verify**: real-browser check (Playwright, matching `templateLibraryUI.test.js`'s established pattern in this repo) exercising each of the 5 flows above against a real running `createApp()` instance — invite → accept → login, assign/resolve/reopen a chat and see it move between queue tabs, post a note with a mention, insert a canned response via `/`, view the SLA report as Admin and confirm an Agent can't reach it.

---

### 6. General contacts CSV import

**Depends on**: nothing.

- **What**: unlock the already-present-but-disabled "Import CSV" button on the Contacts view by reusing `contact_lists`' existing CSV-parsing + atomic upsert-dedup logic (`contactListsRepo.addMembersFromRows`'s `INSERT ... ON CONFLICT (client_id, phone) DO UPDATE`) directly against `contacts`, no list membership involved.
- **Files touched**: `server/src/routes/contacts.js` (new `POST /import`, multipart via the existing `multer` dependency, `requireRole(['Admin','Manager','Agent'])` per item 1), `server/src/repositories/contactsRepo.js` (new `importFromRows`).
- **Schema change**: none — `contacts.unique(client_id, phone)` already supports this.
- **Endpoint**: `POST /api/contacts/import` — `multipart/form-data`, field `file` (CSV columns `phone,name,tags`, matching the Contacts view's existing export format). `200 { "importedCount": 450, "failedCount": 2, "errors": [{"row": 7, "reason": "invalid phone"}] }`.
- **Verify**: upload a CSV with 3 valid rows + 1 duplicate-phone-within-file row; confirm counts; re-upload the same file, confirm no duplicate contacts are created. Pass: `server/test/contactsCsvImport.test.js` green, real browser check that the previously-`disabled` button now completes an import.

---

### 7. Per-contact custom attribute values

**Depends on**: nothing.

- **What**: give `contact_attributes` (type definitions only today) somewhere to actually store a value per contact.
- **Casting strategy, decided per your point 7**: `contact_attribute_values.value` stays `text` (matches this repo's existing loose-storage convention, e.g. `message_templates.body_param_examples`), but **write-time validation** (Zod, in `server/src/utils/validate.js`) checks the submitted value against the attribute's declared `type` before insert — `number` must parse via a strict numeric regex, `date` must be ISO-8601 `YYYY-MM-DD`, `boolean` must be literally `'true'`/`'false'`. A malformed value is rejected with `400` at write time, so item 9's query-time comparisons can generally assume clean data — but item 9 still applies a defensive regex guard before any cast (belt-and-suspenders against a row written before this validation existed, or inserted directly), rather than relying on write-time validation alone.
- **Files touched**: new `server/src/repositories/contactAttributeValuesRepo.js`; `server/src/routes/contacts.js` (extend `GET /:id`, add value endpoints, inherits Contacts' `requireRole(['Admin','Manager','Agent'])`); `server/src/utils/validate.js` (new per-type schema).
- **Schema** — `060_contact_attribute_values.js`:
  ```sql
  CREATE TABLE contact_attribute_values (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    attribute_id uuid NOT NULL REFERENCES contact_attributes(id) ON DELETE CASCADE,
    value text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(contact_id, attribute_id)
  );
  CREATE INDEX idx_contact_attribute_values_contact ON contact_attribute_values(contact_id);
  -- grant + RLS
  ```
  **down()**: guard — refuse if any row exists (real per-contact business data).
- **Endpoints**: `GET /api/contacts/:id/attributes` → `{ "values": [{"attributeId": "...", "name": "city", "type": "text", "value": "Mumbai"}] }`. `PUT /api/contacts/:id/attributes/:attributeId` body `{ "value": "Mumbai" }` → upsert, `200`; `400` on a value that fails the attribute's declared-type validation.
- **Verify**: define a `number` attribute, `PUT` `"abc"` → `400`; `PUT` `"42"` → `200`; delete the attribute definition, confirm the value row cascades away. Pass: `server/test/contactAttributeValues.test.js` green.

---

### 8. Multi-tag contacts

**Depends on**: nothing structurally, but item 9 depends on this.

- **What**: let a contact carry more than one tag, additively, **without** touching `contacts.tag_id` (every existing tag-based broadcast/chat targeting keys off it — per your answer, it stays permanent as the "primary tag," no breaking replace).
- **The backfill you flagged**: without it, every already-tagged contact (real data across 6 clients) would match nothing under the new multi-tag model, silently breaking any segment condition built on it. **Fix**: the migration includes a backfill `INSERT` copying every existing `contacts.tag_id` into `contact_tags` — this only **adds rows to the brand-new table**, it does not `UPDATE` or `DELETE` any existing row in `contacts` or anywhere else.
- **Files touched**: new `server/src/repositories/contactTagsRepo.js`; `server/src/routes/contacts.js` (new sub-routes, inherits Contacts' role gating); Contacts view UI (multi-tag chip picker, additive to the existing single-select).
- **Schema** — `061_contact_tags_multi.js`:
  ```sql
  CREATE TABLE contact_tags (
    contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (contact_id, tag_id)
  );
  -- grant + RLS

  -- Backfill: every already-tagged contact must appear here too, or every
  -- existing tag assignment becomes invisible to the new multi-tag model
  -- and item 9's segment conditions. Insert-only, touches zero existing
  -- rows in contacts/tags.
  INSERT INTO contact_tags (contact_id, tag_id, client_id)
  SELECT id, tag_id, client_id FROM contacts WHERE tag_id IS NOT NULL
  ON CONFLICT (contact_id, tag_id) DO NOTHING;
  ```
  **down()**, corrected per your point 1 — Revision 2's count-comparison guard was unsound: adding one new tag and removing one backfilled tag leaves the counts matching while real data is silently dropped on rollback. Replaced with an actual set-membership check — refuse if any `contact_tags` row has no matching `(contact_id, tag_id)` pair in `contacts.tag_id`, since every row the backfill itself inserted is, by construction, always such a pair; any row that ISN'T is necessarily something added after the migration ran (whether a new tag or `contacts.tag_id` having since changed):
  ```sql
  -- down() guard
  SELECT count(*)::int FROM contact_tags ct
  WHERE NOT EXISTS (
    SELECT 1 FROM contacts c WHERE c.id = ct.contact_id AND c.tag_id = ct.tag_id
  );
  -- if > 0: raise and report the count, same discipline as migrations 032/036/039/040
  ```
  otherwise (count is 0) safe to drop — every remaining row is exactly reconstructable from `contacts.tag_id` again.
- **Endpoints**: `GET /api/contacts/:id/tags`, `POST /api/contacts/:id/tags {"tagId": "..."}`, `DELETE /api/contacts/:id/tags/:tagId`.
- **Verify**: run the backfill against a schema-shaped test fixture with pre-existing tagged contacts, confirm every one appears in `contact_tags` afterward; attach a 2nd tag to one contact, list both back; confirm existing tag-based broadcast targeting (still reading `contacts.tag_id` directly, untouched) is unaffected — `broadcastPacing.test.js` still green unmodified.

---

### 8.5. Contacts-view contact detail panel

**Added after item 8 shipped, per an explicit scope decision — not renumbering anything else in this file (same precedent as item 5.5).** Real gap found while closing out item 8, not anticipated in Revision 3: items 7 and 8 built real per-contact tag/attribute editing, but the only place in the whole app that UI exists is the Chat view's contact-details drawer (a contact reached by opening a chat with them). The Contacts view itself — the natural place to manage a contact's data directly — has no click-through detail at all; a row is inert (name/phone/tag/status/opt-in/created, no interaction). This matters now specifically because **item 9 filters audiences on tags and attributes**, so building a segment and fixing the data it depends on currently requires two unrelated surfaces (Contacts to find who's missing data, Chat to actually open a conversation with them just to fix it).

- **What**: clicking a Contacts-view row opens a detail panel (contact name/phone header + the same two sections the Chat drawer already has: additive multi-tags and attribute values), backed by the **exact same endpoints** items 7/8 already built — `GET/PUT /api/contacts/:id/attributes[/:attributeId]`, `GET/POST/DELETE /api/contacts/:id/tags[/:tagId]`. No new endpoint, no schema change, no migration.
- **The real work is a frontend refactor, not new backend**: `renderContactAttributesDrawer(chat)` and `renderContactExtraTagsDrawer(chat)` (`app.js`, items 7/8) are currently hardwired to the Chat drawer's specific DOM ids (`#drawer-contact-attributes`, `#drawer-contact-extra-tags`, `#drawer-add-tag-select`) and to `chat.contactId`/`state.activeChatId` for their late-response staleness guard. Reusing them from a second surface means generalizing both to take a `contactId` plus a target-element-id set (or container root) and a caller-supplied staleness check, rather than assuming "the currently open chat" — then calling the generalized versions from **both** the Chat drawer (unchanged behavior) and the new Contacts panel. This is the one non-trivial part of this item; everything else is new markup + a click handler + wiring, not new logic.
- **Explicitly out of scope, flagging rather than silently including**: `contacts.tag_id` (the single "primary tag") has never had ANY UI to set it, not even in the Add Contact modal — this item does not add one. It only surfaces what items 7/8 already built (additive multi-tags + attribute values). A primary-tag picker would be a genuinely new feature, not a reuse of existing components, and is a separate decision.
- **Files touched**: `index.html` (new detail panel/modal markup, reusing the drawer's existing section layout), `app.js` (generalize the two render functions above; new click handler on `#contacts-table-body` rows; open/close state for the panel), `index.css` if the drawer's existing styles don't cleanly apply to a modal context. No `server/` changes at all.
- **Schema/migration**: none.
- **Size**: small-to-medium, frontend-only. No backend, no schema, no new endpoints — the entire item is UI plus a moderate refactor of two already-working functions to stop assuming "the open chat" is the only caller. Comparable in scope to item 5.5 (a UI-only pass), narrower than it (2 features reused, not 5) but with a real refactor item 5.5 didn't have. Rough shape: 1 new modal + ~2 generalized functions + 1 click handler + a handful of Playwright tests mirroring the existing drawer tests (`chatUiPass.test.js` tests 11/13) against the new panel instead.
- **Verify**: click a contact row, confirm the panel opens with real data; edit an attribute value and add/remove a tag from the panel, confirm both persist via the same endpoints items 7/8 already tested; reopen the same contact from the Chat drawer and confirm it shows the identical, now-updated data (proving genuine reuse, not a parallel/diverging implementation). Pass: new Playwright tests, existing `contactAttributeValues.test.js`/`contactTags.test.js` untouched (no backend change to regress).

**Status: built and verified.** Built before item 9, per your explicit call — the generalization was cheaper with exactly two callers than it would be after item 9 added a third. `contacts.tag_id` deliberately left with no UI, per your instruction. `renderContactAttributesDrawer`/`renderContactExtraTagsDrawer` (Chat drawer, items 7/8) generalized in place into `renderContactAttributesInto`/`renderContactTagsInto` (any container/wrapper, any contactId, caller-supplied staleness check) — the Chat drawer's own behavior is unchanged (all 13 pre-existing `chatUiPass.test.js` tests still green against the refactored functions), and the new Contacts-view panel (`#modal-contact-detail`) is the second caller. New Playwright test 14 proves genuine reuse, not a parallel copy: editing a tag/attribute from the Contacts panel, then opening the same contact via the Chat drawer, shows the identical just-saved data. No backend/schema change at all — zero new endpoints, matching the plan.

---

### 9. AND/OR audience segment builder

**Depends on**: items 7, 8.

- **What**: a reusable, named filter (tag membership, attribute comparisons, opt-in status) combinable with a flat AND/OR toggle (per your answer — not nested groups), selectable as a third broadcast audience type.
- **Tag condition source, stated explicitly per your point 2**: after item 8's backfill, `contact_tags` is the authoritative, complete source for a "tag" condition — **not** `contacts.tag_id` directly — since it's the superset (every pre-existing single-tag assignment plus any new multi-tag ones). A "has tag X" condition compiles to `EXISTS (SELECT 1 FROM contact_tags WHERE contact_id = contacts.id AND tag_id = $x)`.
- **Attribute condition casting, per item 7's decision**: a `number`/`date` attribute condition compiles with a defensive regex guard before the cast, e.g. for `number`:
  ```sql
  EXISTS (
    SELECT 1 FROM contact_attribute_values v
    WHERE v.contact_id = contacts.id AND v.attribute_id = $attrId
      AND v.value ~ '^-?\d+(\.\d+)?$'
      AND v.value::numeric > $threshold
  )
  ```
  A row that somehow fails the regex guard (bad legacy data) is excluded from the comparison rather than throwing the whole query — matches this repo's no-stored-functions convention (confirmed: zero functions/triggers exist in any of the 43 real migrations), so this stays inline SQL, not a new PL/pgSQL helper.
- **Constraint name correction, per your point 6**: verified by reading migration `039` in full — the real constraint is `broadcasts_audience_not_both`, check `tag_id is null or contact_list_id is null` (my Revision 1 plan invented a wrong name, `broadcasts_audience_exclusive` — corrected here). **Zero-audience check, per your point 6**: the existing constraint already permits both `tag_id` and `contact_list_id` null simultaneously, and `039`'s own comment confirms this is intentional — "both null still means 'everyone' exactly as today." The new 3-way `<= 1` formulation below preserves that exact same "0 selected = everyone" behavior for all three columns; it is **not** a new gap, it's carrying forward existing, documented, intended behavior. For the two pre-existing columns specifically, the new check is byte-for-byte as restrictive as the old one (still forbids any 2-of-2 among `tag_id`/`contact_list_id`), so this is a non-breaking widening, not a behavior change to anything already in production.
- **Files touched**: new `server/src/repositories/contactSegmentsRepo.js`, new `server/src/routes/contactSegments.js` (`requireRole(['Admin','Manager'])`, matching Broadcasts/Contact-Lists), new `server/src/utils/segmentFilter.js` (translates the stored flat-condition-list JSON into a parameterized SQL fragment — never string-concatenates a value), `broadcastRecipientsRepo.js` (new segment-resolution branch).
- **Schema** — `062_contact_segments.js`:
  ```sql
  CREATE TABLE contact_segments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name text NOT NULL,
    filter_json jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- grant + RLS

  ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_audience_not_both;
  ALTER TABLE broadcasts ADD COLUMN segment_id uuid REFERENCES contact_segments(id) ON DELETE SET NULL;
  ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_audience_at_most_one CHECK (
    (tag_id IS NOT NULL)::int + (contact_list_id IS NOT NULL)::int + (segment_id IS NOT NULL)::int <= 1
  );
  ```
  **down()**: guard — refuse if any `contact_segments` row exists, or if any `broadcasts.segment_id` is non-null (real client-defined segments/usage); otherwise drop the new constraint, drop `segment_id`, restore `broadcasts_audience_not_both` exactly as `039` defined it, drop `contact_segments`.
- **`filter_json` shape** (flat list, one top-level combinator — per your answer): `{"combinator": "AND"|"OR", "conditions": [{"field": "tag"|"attribute"|"opt_in_status", "attributeId"?, "op": "eq"|"gt"|"lt"|"contains", "value": ...}, ...]}`.
- **Endpoints**: `GET /api/contact-segments`, `POST /api/contact-segments {"name": "...", "filterJson": {...}}`, `POST /api/contact-segments/preview {"filterJson": {...}}` → `{ "matchingCount": 214 }`.
- **Verify**: create a segment (`tag = VIP` AND `attribute city = Mumbai`), preview count matches a manual SQL count against a test fixture; launch a real broadcast against it (against a stubbed `global.fetch`, never a real Meta call), confirm `broadcast_recipients` contains exactly the matching contacts. Pass: `server/test/contactSegments.test.js` green.

**Status: built and verified, frontend alongside backend.** Both review points from your approval message were investigated, not assumed:
1. **Parameterization** — `segmentFilter.js` binds every value (tag id, attribute id, comparison value) through one `bind()` closure; the only literal SQL is developer-authored (fixed column names, operators from a hardcoded lookup, never `condition.op` dropped in directly). Proven, not just inspected: `contactSegments.test.js` test 4 sets a real attribute value to `"x'; DROP TABLE contacts; --"` and filters on it — the query succeeds, matches exactly that one contact, and `contacts` is confirmed still queryable afterward.
2. **Large-tenant preview risk** — investigated, not assumed fine. This codebase has **no existing `statement_timeout` anywhere** (checked `pool.js`, `tenantContext.js`) because every other query filters by a fixed, known, indexed predicate; `/preview` is the first route to run a genuinely user-composed WHERE clause across the whole `contacts` table. Every `EXISTS` subquery `segmentFilter.js` generates is index-backed (`contact_tags`' PK leads with `contact_id`; `contact_attribute_values` has a `contact_id` index), so a well-formed filter stays fast at real scale — but nothing bounded worst-case latency for an adversarial-or-just-large filter otherwise. Fixed: `SET LOCAL statement_timeout` (5s, `SEGMENT_QUERY_TIMEOUT_MS`), scoped to that one query on that one request's transaction (`tenantContext.js`'s own `SET LOCAL` pattern), applied to **both** `/preview` and actual broadcast-creation against a segment (the same class of query, run as an `INSERT...SELECT` instead of a `COUNT`) — a cancellation (Postgres `57014`) surfaces as a clear 503, not a hung request or a raw 500. Proven, not just configured: `contactSegments.test.js` test 10 runs a real deliberately-slow query under a short `SET LOCAL statement_timeout` directly against this Postgres instance and confirms it raises exactly `57014`. **Explicitly not solved**: a timeout bounds latency, it doesn't make `COUNT(*)` cheaper — at this app's real current scale (CLAUDE.md: a handful of clients, hundreds of contacts each) that's moot, but if a tenant ever grows into hundreds of thousands of contacts, an approximate/capped count would be the real next step. Not built now since nothing demonstrates that scale exists; flagged here rather than silently assumed away.

Migration 051 also widened `broadcasts_audience_not_both` (2-way) to `broadcasts_audience_at_most_one` (3-way) — `broadcastPacing.test.js`'s existing DB-level constraint-name test updated to match (behavior unchanged, still rejects the same 2-of-2 combination, just under its new name). Frontend: New Campaign modal gained a third "By Segment" audience mode with an inline AND/OR condition builder (tag/attribute/opt-in-status conditions, type-aware op choices, a debounced live match-count preview, save-as-segment) — `server/test/segmentBuilderUI.test.js` (new, real browser) covers the mode toggle and proves the live preview count against real fixture data, both for a tag condition and an attribute condition. Full suite: 431/431 (`npm test`, single invocation).

---

### 10. Contact 360 activity timeline

**Depends on**: nothing (pairs naturally with item 14).

- **What**: one read-only endpoint merging a contact's messages, broadcast sends, flow entries, and consent events into one chronological feed — no schema change.
- **Files touched**: `server/src/routes/contacts.js` (new `GET /:id/timeline`, inherits Contacts' role gating).
- **Endpoint**: `GET /api/contacts/:id/timeline` → `{ "events": [{"type": "message_in"|"message_out"|"broadcast_sent"|"flow_entered"|"consent_changed", "at": "...", "detail": {...}}] }`, descending.
- **Verify**: a contact with mixed history returns a correctly-interleaved array; a new contact returns `{"events": []}`.

**Status: built and verified, frontend alongside backend** (new `server/src/repositories/contactTimelineRepo.js`, not just the route — 4 sources are genuinely different shapes, kept as 4 focused queries merged/sorted in JS rather than one UNION ALL). Two real bugs found and fixed by the test's own mixed-history fixture, not by inspection: (1) a broadcast send creates a real `messages` row too, which double-counted as both `message_out` and `broadcast_sent` for the same underlying send — fixed by excluding any message a `broadcast_recipients` row points to from the plain messages query, so each real event appears exactly once, matching the endpoint's 5 mutually-exclusive types. (2) the four per-source queries were run via `Promise.all` on `req.db` — a single checked-out tenant-scoped client (`tenantContext.js`), not the pool — which `pg` flagged as deprecated (concurrent `.query()` calls on one `Client`, "will be removed in pg@9"); switched to sequential awaits. Frontend: the item 8.5 Contacts-view detail panel gained an "Activity" section rendering the real timeline (message/campaign/flow/consent events, newest first) — no separate view built, reusing the existing per-contact panel rather than adding a new one. Tests: `contactTimeline.test.js` (new, 4 tests — empty contact, a 5-source-mixed real fixture proving correct cross-source interleaving and both exclusion rules, tenant isolation, role gating), `chatUiPass.test.js` +1 (test 15, real browser, confirms the panel renders real events newest-first). Full suite: 436/436 (`npm test`).

---

### 10.5. Default `statement_timeout` for every tenant-scoped request

**Added after item 9's approval, per your explicit follow-up question — not renumbering anything else in this file (same precedent as items 5.5/8.5).** Item 9 added `SET LOCAL statement_timeout` to exactly two routes (`/api/contact-segments/preview`, segment-based broadcast creation) because those two run the one genuinely user-composed query in the app. Your question: should this be a connection-level default instead, so the *next* unbounded query someone adds inherits protection automatically, rather than depending on the author remembering this pattern exists? Answered as a recommendation in item 9's follow-up report; this item is that recommendation, approved and built.

- **What**: `middleware/tenantContext.js`'s `acquireTenantConnection` — already the one place every client-authenticated request's connection is set up (`SET LOCAL ROLE wasi_app`, `set_config('app.current_client_id', ...)`) — now also runs `SET LOCAL statement_timeout = '15000ms'` in that same setup step. Same transaction-scoped `SET LOCAL` mechanism already established there, not a new pattern. A route that legitimately needs a different bound (tighter or looser) still layers its own `SET LOCAL statement_timeout` on top, same as items 9's two routes already do — a later `SET LOCAL` in the same transaction simply overrides the earlier one, standard Postgres behavior.
- **Explicitly untouched**: background workers (`broadcastRunner`, `forwardRunner`, `flowRunner`, `alertRunner`) connect via the privileged `pool` directly, never through `acquireTenantConnection` — this default does not reach them. Their tick-based batch-processing shape is a different problem with a different legitimate-duration profile; extending timeout protection there is a separate decision, not made here.
- **The two risk areas you named, checked empirically before picking 15s, not assumed**:
  1. **CSV import of a large file** (`contactsRepo.importFromRows`, `contactListsRepo.addMembersFromRows`) — architecturally immune regardless of file size: `statement_timeout` bounds each individual SQL *statement*, and the import path is a loop of small, separately-awaited `INSERT ... ON CONFLICT` statements, never one big statement. Measured directly: 5,000 rows through the real `importFromRows` function, **1.01ms average per row**, every individual statement nowhere near 15s regardless of total loop length.
  2. **The item 10 timeline query on a contact with heavy history** — the real risk here was `broadcastSentEvents`' join into `broadcast_recipients`, the one source with no `contact_id`-scoped index (confirmed by reading every index on that table: `client_id`, `broadcast_id`, `(broadcast_id, status)` — none on `contact_id` alone). Measured directly against a real fixture (40 broadcasts, 12,040 `broadcast_recipients` rows for one client, the target contact a real `'sent'` recipient on all 40): `EXPLAIN ANALYZE` shows Postgres drives the join from the small `broadcasts` table (42 rows for the client) through the existing `(broadcast_id, status)` index rather than scanning `broadcast_recipients` directly — **6.4ms** for that sub-query, **34ms** for the full 4-source `getTimeline()`. No index added — nothing in this measurement justifies one, and adding an unneeded index isn't free (write overhead, maintenance) — but this is a real, checked finding, not an assumption, and worth revisiting if a client's broadcast volume grows enough to change the query planner's choice of driving table.
- **Files touched**: `server/src/middleware/tenantContext.js` only. No schema change, no new migration.
- **Verify**: a new test (`server/test/statementTimeout.test.js`) — (1) confirms `SHOW statement_timeout` reports `15s` on a connection acquired the normal way (`acquireTenantConnection`), proving the default is actually applied, not just intended; (2) confirms a route-level override still works by re-running item 9's own proof (a short `SET LOCAL statement_timeout` layered on top of the 15s default still cancels a deliberately slow query with Postgres error `57014`) — the override, not just the default, needs to still function after this change. The existing `contactSegments.test.js` test 10 (the mechanism itself works in this Postgres version) is unaffected. Full suite green: `npm test`.

**Status: built and verified.** `acquireTenantConnection` now sets the 15s default; both empirical checks above ran for real against this local DB (not reasoned about) — CSV import 1.01ms/row average across 5,000 rows, timeline query 6.4ms/34ms against a 12,040-row `broadcast_recipients` fixture — before picking 15s, not after. `server/test/statementTimeout.test.js` (new, 2 tests) both pass. Full suite: 438/438 (`npm test`).

---

### 11. Broadcast pause/resume *(new — added per your point 9)*

**Depends on**: nothing.

- **What**: the spec's §10.1 "Pause / Resume Flag Mechanics" — confirmed entirely missing by grep, and it turns out to need **no schema change at all**: `broadcasts.status` (`server/src/db/migrations/003_tenant_tables.js`) is plain `text`, no `CHECK` constraint, and `broadcastsRepo.listActive()` already only ever matches `status = 'Sending'` exactly. Pausing is just setting status to anything else (`'Paused'`) so the runner's next tick naturally stops claiming new batches for it; resuming sets it back to `'Sending'`.
- **Files touched**: `server/src/routes/broadcasts.js` (new actions, `requireRole(['Admin','Manager'])` per item 1's Broadcasts row), `server/src/repositories/broadcastsRepo.js` (reuses the existing `markStatus`, no new method needed).
- **Schema change**: none.
- **Endpoints**: `POST /api/broadcasts/:id/pause` → `400` unless current status is `'Sending'`; else `200 {"id": "...", "status": "Paused"}`. `POST /api/broadcasts/:id/resume` → `400` unless current status is `'Paused'`; else `200 {"id": "...", "status": "Sending"}`.
- **Race behavior, stated explicitly**: a batch `broadcastRunner.js` has already claimed (`FOR UPDATE SKIP LOCKED`) before a pause request lands will still finish sending — this can't be interrupted mid-flight and shouldn't be (a half-sent batch left `pending` forever would be worse). Only the *next* 5-second tick's claim is prevented once status is no longer `'Sending'`. This matches the spec's own described mechanism (§10.1: "the worker checks the campaign status flag... before executing each contact batch") and needs no new locking beyond what `claimBatch` already does.
- **Verify**: launch a broadcast against a stubbed `global.fetch` (never real Meta), pause mid-send, confirm no further batches are claimed after the in-flight one completes; resume, confirm sending continues. Pass: `server/test/broadcastPauseResume.test.js` green.

**Status: built and verified, frontend alongside backend.** One real correction found while writing the test, not by inspection: `processBroadcast()` itself has **no status check at all** — reading `broadcastRunner.js` confirms the actual gate is entirely `tick()`'s call to `broadcastsRepo.listActive()` (`WHERE status = 'Sending'`), which simply never selects a paused broadcast for `processBroadcast` to be called on in the first place. The test asserts this real mechanism directly (`listActive()` excludes/includes the broadcast around pause/resume) rather than the wrong premise of a guard inside `processBroadcast` — the plan's own "race behavior" description above is still accurate (an in-flight tick's already-claimed batch finishes), it just locates correctly to the calling layer, not the function itself. Frontend: Campaigns table gained a Pause/Resume button per row (shown only for `Sending`/`Paused` respectively), calling the two new endpoints and refreshing the row. Tests: `broadcastPauseResume.test.js` (new, 5 — the real `listActive()` gate proven with a live send-and-resume round trip through a real Utility-category template, both 400 rejections, 404, role gating), `broadcastPauseResumeUI.test.js` (new, real browser, 2 — button appears for the right status, click pauses/resumes for real server-side, not just in the DOM). Full suite: 445/445 (`npm test`).

---

### 12. Smart Sending — anti-duplicate broadcast spacing

**Depends on**: nothing.

- **What**: skip a contact if they already received another broadcast within a configurable recent window (spec §3.5/§10.1).
- **Files touched**: `server/src/services/broadcastRunner.js` (new pre-send check), `server/src/repositories/broadcastRecipientsRepo.js` (new `hasRecentSend` query).
- **Schema** — `063_broadcast_smart_sending.js`: `ALTER TABLE broadcasts ADD COLUMN smart_sending_hours integer;` (nullable — null means disabled, matching the existing nullable-means-off convention already used by `pacing_config`).
  **down()**: `DROP COLUMN smart_sending_hours` — no guard needed, it's a pure opt-in throttle knob with no derived data depending on it.
- **Endpoint**: extend the existing `POST /api/broadcasts` body with optional `smartSendingHours`; no new route.
- **Verify**: two broadcasts with `smartSendingHours` set, same target contact, launched (against a stubbed `global.fetch`) within the window — second send is `skipped` with `error_reason: 'smart_sending_window'`; without the field, both send normally.

**Status: built and verified, frontend alongside backend.** The check runs in `sendOneRecipient`, first — before any consent check or Cloud API call — against ANY of the contact's other broadcast sends client-wide (not just the same campaign, which could never target one contact twice anyway); `hasRecentSend` joins through the linked message for the real send timestamp (`broadcast_recipients` has no send-time column of its own, same shape as item 10's timeline query), and only counts a genuine `'sent'` row, not a skipped/failed attempt. One real bug caught by the test's own fixture: the first draft attached the test's tag via item 8's *additive* `contact_tags` endpoint, but tag-based broadcast targeting (`createFromAudience`) filters `contacts.tag_id` — the separate, untouched primary tag — so the fixture matched zero recipients until fixed to set `tag_id` directly at contact creation. Frontend: New Campaign modal gained a "Smart Sending" dropdown (Off / 24h / 3 days / 7 days), alongside the existing Sending Pace field. Tests: `broadcastSmartSending.test.js` (new, 4 — real skip-on-repeat via a live send-and-skip round trip through a real Utility-category template, normal double-send when disabled, the skipped-attempt-doesn't-count edge case, the client-wide-not-same-broadcast check), `smartSendingUI.test.js` (new, real browser, confirms the picked option persists server-side, not just in the form). Full suite: 450/450 (`npm test`).

---

### 13. Messaging tier tracking *(migration only — per your instruction, no field-name guess)*

**Depends on**: nothing.

- **What**: capture and expose the WABA's current messaging tier alongside the already-tracked `quality_rating`.
- **Files touched**: `server/src/services/alertRunner.js` — add a clearly marked `// TODO(messaging-tier): confirm the real Graph API field name against a live connected WABA before implementing this fetch — do not guess from the reference spec, which doesn't give a verified field name either. Follow this codebase's own established practice (see CLAUDE.md's Meta Official Template Library history: 'real Phase 0 API research, not assumed').` No fetch code is written in this pass.
- **Schema** — `064_wabas_messaging_tier.js`: `ALTER TABLE wabas ADD COLUMN messaging_tier text;` (nullable, unpopulated until the TODO above is resolved).
  **down()**: `DROP COLUMN messaging_tier` — no guard needed (column will be entirely null until the follow-up fetch work lands).
- **Endpoint**: none yet — surfacing it in `GET /api/onboarding/whatsapp/status` is follow-up work once the column can actually be populated.
- **Verify**: migration applies cleanly to a schema-shaped test fixture; `wabas.messaging_tier` is nullable and unused by any code path (confirm nothing breaks with it always null).

**Status: built and verified — migration + TODO only, exactly per scope, no fetch code.** Checked one thing before writing the migration, not assumed: whether this needed the same `wasi_app` column-grant fix CLAUDE.md documents for `clients` (migration 043) — it doesn't, because `wabasRepo.js`'s own header comment confirms every `wabas` access deliberately stays on the privileged `pool`, never the restricted role, since `access_token_encrypted` is already column-revoked from `wasi_app` (a `select *` under that role errors regardless of which other columns exist). `server/test/wabasMessagingTier.test.js` (new, 2 tests) confirms the column exists, is nullable, and an existing read path is unaffected. Full suite: 462/462 (`npm test`).

---

### 14. CTWA referral capture + attribution *(built and tested against a simulated payload only, per your instruction)*

**Depends on**: nothing (pairs with item 10).

- **What**: when an inbound message carries Meta's documented `referral` object (ad-click origin), store it.
- **Files touched**: `server/src/routes/metaWebhook.js` (capture `messages[].referral` into the insert — this is parsing an **inbound**, already-arrived webhook payload, not a call to Meta), `server/src/repositories/chatsRepo.js` (accept it in `insertInbound`), new `GET /api/analytics/ctwa`.
- **Schema** — `065_message_referral.js`: `ALTER TABLE messages ADD COLUMN referral jsonb;` (nullable, stores Meta's object verbatim per §6.2's documented shape: `source_url`, `source_type`, `source_id`, `headline`, `body`, `media_type`, `image_url`/`video_url`, `ctwa_clid`).
  **down()**: guard — refuse if any `messages.referral` is non-null (real ad-attribution data once live traffic exists).
- **Endpoint**: `GET /api/analytics/ctwa?since=...` (Admin, Manager) → `{ "bySource": [{"sourceId": "...", "headline": "...", "messageCount": 42}] }`.
- **Verify — explicitly scoped to your instruction**: feed `metaWebhook.js` a **simulated** payload (matching §6.2's documented real shape, constructed as test fixture data, never real traffic) containing a `referral` block, confirm it lands in `messages.referral` and surfaces in the aggregate endpoint and item 10's timeline. **No verification against real ad traffic is performed by me** — noted in the test file's own header comment as pending on your side, matching your instruction verbatim.

---

### 15. Meta conversation pricing / cost calculator

**Depends on**: nothing.

- **What**: estimate monthly Meta conversation spend from `usage_logs.conversations_billed`.
- **Files touched**: new `server/src/repositories/conversationPricingRepo.js`, new `server/src/routes/conversationPricing.js` (admin-managed rates, mounted under `/api/admin`, `requireAdminAuth()` — not a client-facing write surface), `server/src/routes/analytics.js` (new cost-estimate endpoint, Admin/Manager).
- **Schema** — `066_conversation_pricing.js`:
  ```sql
  CREATE TABLE conversation_pricing (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category text NOT NULL CHECK (category IN ('MARKETING','UTILITY','AUTHENTICATION','SERVICE')),
    country_code text NOT NULL,
    rate_inr numeric(8,4) NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(category, country_code)
  );
  -- select-only grant to wasi_app (read-only reference data, matching plans/template_library's pattern); writes stay admin-only on the privileged pool
  ```
  **down()**: guard — refuse if any row exists (real admin-entered pricing).
- **Important, unchanged from Revision 1**: shipped **empty**. The spec's own figures (e.g. "~0.78 INR") are unverified and possibly stale — never seeded from the reference document. An admin enters real current rates.
- **Endpoint**: `GET /api/admin/conversation-pricing` (admin CRUD), `GET /api/analytics/cost-estimate?month=2026-09` → `{ "estimatedInr": 4820, "byCategory": {...} }`, with an explicit "rates not configured" flag per category rather than silently returning `0`.
- **Verify**: with rates configured (test data, not real Meta figures), cost estimate matches a manual calculation; with no rates configured, the endpoint clearly reports that.

---

### 16. Hub API v1 outbound idempotency key *(redesigned to close the race you flagged)*

**Depends on**: nothing.

- **The race in Revision 1**: check-then-insert (look up the key, if absent proceed to send, then insert) leaves a window where two concurrent retries both pass the check before either has inserted — both send. **Fix**: insert the key row **first**, before calling Meta at all, and let the table's own unique constraint be the race referee.
- **Flow**:
  1. If an `Idempotency-Key` header is present, attempt `INSERT INTO api_idempotency_keys (client_id, api_key_id, idempotency_key, status) VALUES (..., 'in_progress') ON CONFLICT (client_id, idempotency_key) DO NOTHING RETURNING id`.
  2. **Insert succeeded** (a row came back) → this caller won the race → proceed to send to Meta → on completion, `UPDATE ... SET status = 'completed', response_status = $, response_body = $ WHERE id = $`.
  3. **Insert did nothing** (conflict, no row returned) → this caller lost the race → `SELECT` the existing row. If `status = 'completed'`, return the **stored** response verbatim (safe replay, matches the first response exactly, no second Meta call). If `status = 'in_progress'`, **the second caller receives `409 { "error": { "code": "IDEMPOTENT_REQUEST_IN_PROGRESS", "message": "A request with this idempotency key is already being processed. Retry shortly." } }`** — this is the explicit answer to your "what does the second caller receive" question.
  4. **Abandoned in-flight guard**: if a request crashes after step 1 but before step 2's completion, `status = 'in_progress'` forever would permanently block that key. A stale row (`status = 'in_progress'` and `created_at` older than 2 minutes) is treated as abandoned: a fresh caller may reclaim it via `UPDATE ... SET created_at = now() WHERE id = $ AND status = 'in_progress' AND created_at < now() - interval '2 minutes' RETURNING id`, then proceeds exactly as step 2. This mirrors the lease-with-timeout pattern already established in this codebase (`forwardRunner`'s enqueue-time lease, `broadcastRecipientsRepo.claimBatch`'s `FOR UPDATE SKIP LOCKED`), not a new pattern.
- **Files touched**: `server/src/routes/apiV1Messages.js`, new `server/src/repositories/apiIdempotencyKeysRepo.js`.
- **Schema** — `067_api_idempotency_keys.js`** (renumbered 2026-09-08 from `056` — that number is now items 1-15's actual production-safe range, `056`-`066`; see CLAUDE.md's Known Gaps for the full migration-renumbering history. This is the real next-free number, checked against production's `pgmigrations` directly, not assumed)**:
  ```sql
  CREATE TABLE api_idempotency_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
    response_status integer,
    response_body jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(client_id, idempotency_key)
  );
  -- grant + RLS
  ```
  **down()**: guard — refuse if any row exists (real request-dedup history, even short-lived, is evidence a real integration used this).
- **Endpoint**: `POST /api/v1/messages` — behavior above, `Idempotency-Key` header optional; omitting it skips this path entirely (unchanged existing behavior).
- **Verify**: send the identical request twice **concurrently** with the same key against a stubbed `global.fetch`, confirm exactly one real call to `graph.facebook.com` fires and the loser gets `409`; send the same key again **after** the first completes, confirm it gets the cached `200` with identical body, still zero additional `fetch` calls; simulate an abandoned in-progress row (backdate `created_at`), confirm a new caller can reclaim and complete it. Pass: `server/test/apiV1Idempotency.test.js` green, explicitly covering all four cases above.

---

### 17. Green Tick / Official Business Account application — **PARKED**

Per your instruction, not planned further. Left in the backlog only as a named placeholder for a future pass: it needs a live-API research spike (no verified working Graph API endpoint for this exists in anything read so far, including the reference spec) and is only testable against a real, OBA-eligible connected WABA — out of scope until you ask for it again.

---

### 18. Flow builder — Ask Question + API HTTP Request nodes

**Depends on**: nothing structurally, scheduled last for engineering-risk reasons (unchanged from Revision 1 — not addressed in your corrections, so left as originally planned).

- **What**: two new node types the spec's chatbot builder expects and this engine doesn't have — free-text capture with validation, and an outbound HTTP call with response-value capture.
- **Files touched**: `server/src/services/flowEngine.js` (two new `executeNode` branches + a new "waiting for a text reply" resolution path), `server/src/routes/metaWebhook.js` (route a free-text inbound reply into an `ask_question`-waiting flow state).
- **Schema** — `068_flow_nodes_widen_types.js`** (renumbered 2026-09-08 from `057` — collided with item 3's migration once Phase D's `044`/`046`-`054`/`056` were renumbered to `056`-`066` after a production migration-ordering blocker; see CLAUDE.md's Known Gaps for the full history. Bumped to sit right after item 16's `067`, keeping plan order)**:
  ```sql
  ALTER TABLE flow_nodes DROP CONSTRAINT flow_nodes_type_check;
  ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_type_check
    CHECK (type IN ('send_text','send_interactive_buttons','send_template','delay','action','end','ask_question','api_request'));
  ALTER TABLE flow_edges DROP CONSTRAINT flow_edges_condition_type_check;
  ALTER TABLE flow_edges ADD CONSTRAINT flow_edges_condition_type_check
    CHECK (condition_type IN ('always','button_id','keyword','default','timeout','valid_reply','invalid_reply'));
  ```
  **down()**: guard — refuse if any `flow_nodes.type IN ('ask_question','api_request')` row exists, or any `flow_edges.condition_type IN ('valid_reply','invalid_reply')` row exists (real client-built flow logic); otherwise restore the original CHECKs exactly as migration `023` defined them.
- **Config shapes**: `ask_question`: `{"promptBody": "...", "variableName": "email", "validation": {"kind": "email"|"phone"|"any"|"regex", "pattern": "..."}, "invalidRetryBody": "..."}`. `api_request`: `{"method": "GET"|"POST", "url": "...", "headers": {...}, "bodyTemplate": {...}, "responseVariableName": "orderStatus", "jsonPath": "$.status"}`.
- **Security note, unchanged**: `api_request.url` is user-entered and hit server-side — apply the same partial SSRF guard already established for `zapierSubscribeSchema` (reject link-local + non-http(s) schemes), matching existing precedent.
- **Dependency note, unchanged**: confirm the server's actual Node.js runtime supports global `fetch` (Node ≥ 18) before relying on it; if not, this needs a new dependency requiring your explicit sign-off.
- **Verify**: build a 3-node flow (message → `ask_question` w/ email regex → message using `{{email}}`) — no real WhatsApp send, exercised via `flowEngine`'s functions directly against a stubbed `messagingService`/`global.fetch`, matching this repo's existing `flowEngineRunToRest.test.js` pattern; send invalid text (confirm re-prompt), then valid (confirm advance + substitution); `api_request` node hitting a **local test HTTP server** (never an external one) correctly captures a response field. Pass: new `server/test/flowEngineNewNodes.test.js` green, plus `flowEngineRunToRest.test.js` still green.

---

## Parked — not scoped further, per your answer 4

| Item | Status |
|---|---|
| **19. AI RAG / GPT-4o chatbot node** | Parked. Needs a real external LLM provider account + API key and a knowledge-base schema this repo has none of. |
| **20. Real-time push for chat (WebSocket/SSE)** | Parked. Current 4s polling is a documented, working, deliberate choice. |
| **21. WhatsApp Catalog, product messages, Shopify/WooCommerce triggers** | Parked. Large — needs its own scoping pass if revisited. |
| **22. Carousel template cards** | Parked. Touches the entire template pipeline. |
| **23. Broadcast link-click tracking** | Parked. Needs Wasi's own redirect/shortener infra Meta doesn't provide natively. |

---

## Phase E — Messaging failure visibility *(new — from a real production incident, not part of the AiSensy gap analysis)*

**Trigger**: a client's sends were being rejected by Meta with error 131042 (business eligibility / payment issue) and it took a manual database query to find out — neither the client nor Wasi staff saw it anywhere. Planned per your instruction, in the same format/depth as items 1–18. **No building has started.**

---

### 24. Meta send-failure visibility (per-message, account banner, admin health view, error catalog)

**Depends on**: nothing structurally. If item 1 (team-member auth) has already shipped by the time this is built, Part A's chat-UI failure display should be visible to whichever roles can already see chat messages under item 1's matrix (Admin/Manager/Agent), not owner-only — a one-line gating change, not a real dependency.

**Investigated first, per your instruction — is any error code currently swallowed before reaching the `messages` row?**

Traced every real outbound-send call site by grep (`metaClient.sendTextMessage`/`sendTemplateMessage`/`sendInteractiveMessage`/`sendListMessage`): every one is called from exactly one place, `messagingService.js`'s `sendChatMessage`/`retryMessage` — used identically by chat replies (`routes/chats.js`), broadcast campaigns (`broadcastRunner.js`), automation/flow sends (`flowEngine.js`), and the Hub API (`apiV1Messages.js`). (`alertNotifier.js` also calls `sendTemplateMessage` directly, but that's Wasi's own internal alert channel to staff, not a client message — no `messages` row involved, out of scope here.)

**Finding: `meta_error_code` is not swallowed.** Every one of those callers' failures already lands on the `messages` row via `chatsRepo.markFailed(db, clientId, messageId, err.message, err.metaError?.code)` (`messagingService.js:175,222`), fed by `metaClient.js`'s `graphFetch`, which attaches Meta's real `data.error` object as `err.metaError` on every non-2xx response (`metaClient.js:60-71`) — confirmed against real production data in the prior investigation (2 real 131042 failures, 4 real 131026 failures, both correctly carrying `meta_error_code`). `broadcast_recipients.error_reason` has no `meta_error_code` column, but this is **not** a gap — by design (see that table's own migration comment), delivered/read/failure detail for a broadcast recipient is always looked up by joining to its linked `messages.id` at read time, matching the existing "one source of truth" convention already used for delivered/read counts. So Parts B and C below can read `messages` directly regardless of which subsystem originated the send.

**Finding: what IS effectively lost is the *quality* of the text, and it's a repeat of a bug already found and fixed once before, in a different route.** `routes/templates.js` already has a `describeMetaError(err)` helper (lines 17-34) with this exact comment: Meta's raw error object often carries a more specific, human-readable `error_user_title`/`error_user_msg` than the flat `err.message` alone — found live when a client only saw a content-free rejection popup because that route was passing along the terse message. That fix was **never applied to the send path**: `messagingService.js`'s two catch blocks store bare `err.message` into `error_reason`, discarding `error_user_title`/`error_user_msg` on the exact same `err.metaError` object every time. Separately, the *asynchronous* delivery-status webhook path (`metaWebhook.js`'s `handleStatuses`, line 308) uses yet a **third** Meta field, `error?.title`, for the same column — so today, the same numeric code can carry differently-worded `error_reason` text depending on whether the failure happened synchronously (the initial send) or asynchronously (a later delivery-status webhook). This is why Part D's mapping is keyed **only** on the numeric `meta_error_code`, never on parsing `error_reason` text — the free-text field is inconsistent by path and was never reliable to build on.

**Checked, per your question — does anything parse or match on `error_reason` text (as opposed to the numeric `meta_error_code`)?** Grepped every read site of `error_reason` in `server/src`:
- `alertRunner.js` — **grep-verified zero occurrences of `error_reason` anywhere in the file.** `checkAuthClassErrors` (the only alert condition that inspects a failure code) matches exclusively on `m.meta_error_code = any($1::int[])` — it never touches the free-text column at all. **Direct answer: no, `alertRunner.js` does not string-match on `error_reason`.**
- `admin.js`'s `/failures/sends` — selects and returns `error_reason` raw for display only, no comparison.
- `broadcastRecipientsRepo.js` — writes only (its own fixed literal strings, e.g. `'Contact was deleted before this recipient could be sent.'`, for cases that never call Meta at all — untouched by anything below).
- `apiV1Messages.js:37` — **passes `error_reason` straight through to the Hub API's external, out-of-repo callers** (a client's own CRM, or their Zapier integration). This is the one real place richer/changed wording has a blast radius we can't grep our way into — a third party could plausibly be pattern-matching this free-text field today. Not blocking this item, but noted honestly rather than silently: if/when this ships, treat the wording change on `GET/POST /api/v1/messages`'s `error_reason` field as a documented, communicated change (a line in `crm-integration-guide.md`'s changelog-equivalent), not a silent one.
- **One real consumer *does* string-match derived text, and it's a test, not runtime code**: `server/test/metaWebhookDispatch.test.js:126` — `assert.match(rows[0].error_reason, /Re-engagement message/)` — asserted against `REAL_STATUS_ONLY_PAYLOAD_SHAPE`, a captured-real Meta webhook-status fixture (code 131047) in the same file. That fixture's `errors[0]` object has fields `code`/`title`/`message`/`error_data.details` — **no `error_user_title`/`error_user_msg` at all** (those fields are confirmed present on the synchronous send/template-management REST error envelope `templates.js`'s original fix targeted, not on this async webhook-status envelope — the two are structurally different Graph API payloads, not the same shape reused).

**Revised per your instruction: `error_reason`'s existing wording is now left completely untouched, for everyone, forever — including internally.** The original plan above had `messagingService.js` start writing `describeMetaError(err)`'s richer text *into* `error_reason` itself, which (per your point 1) would silently change wording an external Hub API caller could be matching on, with no way for us to know. Fixed by **not overloading the existing column at all**: a brand-new, purely additive nullable column, `messages.error_detail`, carries the richer text; `error_reason` keeps receiving exactly `err.message` exactly as it does today — byte-for-byte unchanged, for every caller, forever, not just "unchanged until this ships."

- **`messagingService.js`'s two synchronous send-call catch blocks** change from `chatsRepo.markFailed(db, clientId, messageId, err.message, err.metaError?.code)` to `chatsRepo.markFailed(db, clientId, messageId, err.message, err.metaError?.code, describeMetaError(err))` — a new 5th argument. `chatsRepo.markFailed`'s SQL adds `error_detail = $5`; `error_reason = $3` (still `err.message`) is untouched in the same statement. `error_detail` is only ever set to a non-null value when `describeMetaError(err)` actually differs from `err.message` (i.e., Meta genuinely supplied a more specific `error_user_title`/`error_user_msg`) — when there's nothing richer, `error_detail` stays `null` rather than redundantly duplicating `error_reason`, so "a non-null `error_detail`" is itself a meaningful signal, not noise.
- **`metaWebhook.js`'s `handleStatuses` is still explicitly left alone**, exactly as the prior revision decided, for the same reason: its payload shape has no `error_user_title`/`error_user_msg` to extract in the first place (see the real captured fixture above), so there's nothing richer to put in `error_detail` for that path either — `error_detail` stays `null` on a webhook-status-driven failure. This is a second, independent reason the standing guardrail below matters: nothing about this revision gives a reason to touch that path now, and none should be invented later without a real, stated reason.

**Where the new field is surfaced**:
- **Internally** — Part A's chat-UI tooltip and admin's existing flat `/failures/sends` list (both already display raw `error_reason` today) add `error_detail` alongside it, preferring `error_detail || error_reason` for their raw/debug text. Parts B and C's plain-language display never depended on either raw field — both key strictly on the numeric `meta_error_code` via Part D's static catalog — so they're unaffected by this whole finding either way.
- **Hub API, per your instruction to check feasibility**: **feasible, and this is the better design.** `GET /api/v1/messages/:id/status` (`apiV1Messages.js:32-41`) already returns `error_reason`/`meta_error_code` as plain fields in a `200` JSON body (not the `apiV1ErrorHandler` error envelope) — adding one more field, `error_detail: message.error_detail`, right alongside them is a purely additive change to that same body. Per ordinary REST/JSON client behavior (and this repo's own Hub API conventions — see CLAUDE.md's error-shape section, which is about the 4xx/5xx envelope, not this 200 body), an existing integration that doesn't know about a new field ignores it; nothing about adding a field can break a caller that was never reading it. `error_reason` itself is not touched, so a caller that *is* pattern-matching it today keeps seeing byte-for-byte identical text. **Files touched**: `apiV1Messages.js` (the new field), `crm-integration-guide.md` (document the new optional field in the `get_message_status`/message-status response shape — additive, not a version bump, but worth a line per this repo's living-documentation discipline).

**Standing guardrail, stated explicitly per your point 2**: `server/test/metaWebhookDispatch.test.js:126`'s `assert.match(rows[0].error_reason, /Re-engagement message/)` asserts on wording, against a real captured Meta fixture. Nothing in this item's current design touches that path, so the test is untouched. **If any future change to this item (or anything else) ends up genuinely affecting that path's wording, the fix is to update the assertion deliberately — with a comment stating what changed and why — never to loosen the regex just to make it pass.** This is a standing rule for this specific test going forward, not just a note for this build pass.

**Migration now needed — one small additive column, not "none" as the prior revision said.** `messages.error_reason`/`meta_error_code` (migrations `006`/`018`) already existed and needed no schema change for the *original* design; this revision's new `error_detail` column is new data being captured for the first time, so it does need one. Per your instruction not to claim a specific migration number while Phase D is actively consuming numbers concurrently in another session, this is named descriptively here and the real number is assigned by re-checking the migrations directory at build time:
```sql
-- <next-available-number>_messages_error_detail.js
ALTER TABLE messages ADD COLUMN error_detail text;
```
**down()**: guard — refuse if any `messages.error_detail` is non-null (once populated, it's the only surviving copy of Meta's richer per-incident text — not reconstructable from `error_reason` alone), matching the `032`/`036`/`039`/`040` live-row discipline; otherwise safe to drop, a purely additive nullable column with nothing else depending on it.

---

#### Part D first (the other three parts depend on it): meta_error_code → plain language catalog

- **What**: a static, hand-curated lookup table from Meta's numeric `meta_error_code` to `{ plainLanguage, whoFixes, severity, steps }`, seeded from codes actually seen in this app's real production data (confirmed via the prior read-only DB investigation) plus the two you named that haven't occurred yet but are documented Meta codes worth having ready.
- **Shared Node+browser module, following this codebase's own established pattern** (`server/src/utils/templateParams.js`'s dual `module.exports`/`window.templateParams` export, served raw via `GET /templateParams.js` — see CLAUDE.md's "flag while typing" entry): new `server/src/utils/metaErrorCatalog.js`, dual-exported the same way, served via a new static route `GET /metaErrorCatalog.js` (`server/src/app.js`), loaded by `<script>` tag in both `index.html` (before `app.js`) and `admin/index.html` (before `admin/app.js`) — so the chat UI, the account banner, and the admin health view all resolve a code to the exact same wording the server itself uses, never three hand-duplicated copies.
- **Seed content** (`severity` reuses the exact 3 values `alert_events` already constrains to — `'info'|'warning'|'critical'` — for consistency with the existing alerting system, not a new vocabulary):

  | Code | Plain language | Who fixes | Severity | Account-wide? |
  |---|---|---|---|---|
  | 131042 | "Meta paused sending for this WhatsApp number because of a billing/payment problem on the connected Meta Business Account." | client (in Meta Business Manager) | critical | yes |
  | 190 | "Wasi's connection to this WhatsApp Business Account has expired or was revoked." | client (reconnect), escalate to Wasi if reconnecting doesn't fix it | critical | yes |
  | 10 | "Meta says this app no longer has permission to send for this account." | client (reconnect), escalate to Wasi if reconnecting doesn't fix it | critical | yes |
  | 368 | "Meta has temporarily restricted this WhatsApp Business Account for a policy violation." | client (appeal via Meta Business Manager) | critical | yes |
  | 131026 | "This specific message couldn't be delivered — the number may be invalid, unreachable, or not on WhatsApp." | client (verify the number) | warning | no |
  | 132001 | "The template name/language sent doesn't match what's approved on Meta." | us (Wasi — re-sync templates) | warning | no |
  | 131047 | "More than 24 hours have passed since the customer last messaged — only a template message can restart the conversation." | client (agent — send a template instead) | info | no |
  | *(any other code)* | "Meta rejected this message for an unrecognized reason (code {code})." Raw `error_reason` text always shown alongside, never hidden. | unknown | warning | no |

  The fallback row matters as much as the mapped ones — matches this codebase's existing honesty convention for the unmapped-webhook-event case (`metaWebhook.js`'s `handleUnmappedWabaEvent`): never guess a plain-language explanation for a code that isn't in the table, say plainly that it's unrecognized and show the raw text.
- **Consistency fix, small and in-scope** (directly serves "we see problems before clients report them" — the stated goal of this whole item): `alertRunner.js`'s hardcoded `AUTH_CLASS_ERROR_CODES = [190, 10]` (used by `checkAuthClassErrors`) is replaced with `metaErrorCatalog.accountWideCodes()` (a function reading the table above) — one list instead of two that could silently drift apart the next time a code is added.
- **Files touched**: new `server/src/utils/metaErrorCatalog.js`; new migration (see above); `server/src/app.js` (new static route); `index.html`, `admin/index.html` (new `<script>` tags); `server/src/routes/templates.js` (`describeMetaError` now imported, not locally defined); `server/src/repositories/chatsRepo.js` (`markFailed` gains the `error_detail` param/column); `server/src/services/messagingService.js` (its two send-call catch blocks pass `describeMetaError(err)` as the new argument — `metaWebhook.js` is deliberately **not** in this list, see the investigation above); `server/src/services/alertRunner.js` (`AUTH_CLASS_ERROR_CODES` sourced from the catalog); `server/src/routes/apiV1Messages.js` (new `error_detail` field); `crm-integration-guide.md` (document the new field).
- **Verify**: unit test every seeded code resolves to its exact row; an unmapped code (e.g. `999999`) resolves to the fallback row, never throws; `templates.js`'s existing template-rejection-toast tests still pass unchanged (behavior-preserving move, not a behavior change); a stubbed Meta response carrying `error_user_msg` produces that text in a new message's `error_detail` **and confirms `error_reason` on that same row is still exactly `err.message`, unchanged**; a stubbed Meta response with no `error_user_title`/`error_user_msg` produces `error_detail: null`; `GET /api/v1/messages/:id/status` against a message with a populated `error_detail` returns it as an additive field, with `error_reason` byte-for-byte identical to what today's Hub API test suite already asserts (`server/test/apiV1.test.js` unmodified); `server/test/metaWebhookDispatch.test.js`'s existing `/Re-engagement message/` assertion still passes **unmodified**, confirming the webhook-status path was genuinely left alone. Pass: new `server/test/metaErrorCatalog.test.js` green, `server/test/templateEdit.test.js`/existing template tests/`server/test/apiV1.test.js`/`metaWebhookDispatch.test.js` all still green.

---

#### Part A: per-message failure reason in the chat UI

- **What**: today, a failed message already shows a "⚠ Retry" button whose `title` attribute is a hover tooltip of the *raw* `error_reason` (`app.js:550-551`, `msg-retry-btn`) — easy to miss, and in Meta's own wording. This replaces/augments that with an always-visible plain-language line under the failed bubble.
- **Files touched**: `app.js`'s `statusBadge(m)` (chat-message-list renderer, ~line 548) — when `m.status === 'failed'`, look up `metaErrorCatalog.describe(m.meta_error_code)` (the shared browser-global from Part D) and render `{plainLanguage}` under the bubble, with the existing Retry button next to it; the tooltip on that line becomes `m.error_detail || m.error_reason` (the new richer field when Meta supplied one, falling back to the existing raw text otherwise) — kept, not dropped, useful for you/support even after plain-language exists. `index.html` (a small CSS class for the new failure-reason line, e.g. `.msg-failure-reason`, matching existing `.msg-status`/`.msg-time` styling conventions).
- **No new endpoint** — `GET /api/chats/:id/messages` already does `select *` (`chatsRepo.listMessages`), so `meta_error_code`/`error_reason`/(the new) `error_detail` are already in every response; this is a frontend-only change.
- **Verify**: real browser check (Playwright, per this repo's own convention for UI verification) — seed a `messages` row with `status='failed'`, `meta_error_code=131042`, and a populated `error_detail` against a schema-shaped test fixture (never touching the 6 real clients' data), confirm the chat view shows the plain-language line, the Retry button still works, and hovering shows `error_detail`'s text; seed a second row with `error_detail: null`, confirm the tooltip falls back to `error_reason`.

---

#### Part B: account-level banner for account-wide errors

- **What**: a persistent, dismissible-per-session (not permanently dismissible — it should reappear next login while the condition persists) banner in the client dashboard when their connected WABA has a recent account-wide failure (131042, 190, 10, 368 — the `accountWide: true` rows from Part D's table), naming the plain-language cause and where to act.
- **Data source, live-computed, no new column** (matches this codebase's established "compute at read time, don't duplicate" convention — see broadcastRunner.js's own comment on delivered/read counts): extend the **existing** `GET /api/onboarding/whatsapp/status` endpoint (`routes/onboarding.js:36`) — already called on app load by 4 separate existing call sites in `app.js` (lines 2379, 2460, 3188, 4321) — with a new `accountAlert` field: `null`, or `{ code, plainLanguage, whoFixes, steps, occurrenceCount, mostRecentAt }` for the most severe/recent account-wide failure in the last 24 hours for this client's connected WABA, looked up via `metaErrorCatalog` server-side.
  ```sql
  select meta_error_code, count(*)::int as occurrence_count, max(sent_at) as most_recent_at
  from messages
  where client_id = $1 and status = 'failed'
    and meta_error_code = any($2::int[])  -- Part D's accountWideCodes()
    and sent_at > now() - interval '24 hours'
  group by meta_error_code
  order by most_recent_at desc
  limit 1
  ```
- **Files touched**: `server/src/routes/onboarding.js` (`GET /whatsapp/status` extended); `app.js`'s `enterApp()` (new banner render call, once per session load — matching the existing pattern of app-shell-level setup already in that function, e.g. the sidebar account-indicator fix); `index.html` (new banner element in the app shell, above the main view area so it's visible regardless of which view is active).
- **Verify**: seed a schema-shaped test fixture with 2 recent 131042 failures for a test client, confirm `GET /whatsapp/status` returns the populated `accountAlert`; confirm a client with only old (>24h) or non-account-wide (e.g. 131026) failures gets `accountAlert: null`; real browser check that the banner renders with the plain-language text and persists across a view switch, and reappears after a fresh login while the condition still holds. Pass: new `server/test/accountAlertBanner.test.js` green.

---

#### Part C: admin health view grouped by error code

- **What**: extend the admin panel's **existing** Failures tab (`admin/app.js`'s `loadFailures()`/`renderFailedSends()`, already fetching `GET /api/admin/failures/sends` — a flat, ungrouped list of every failed message) with a new grouped summary table above it: every client with recent failures, grouped by `meta_error_code`, with counts — so a spike or a new account-wide problem is visible without reading 200 individual rows.
- **New endpoint**: `GET /api/admin/failures/by-error-code?days=7` (default 7, same clamp convention as `/volume`'s `days` param) →
  ```json
  [{ "client_id": "...", "client_name": "...", "meta_error_code": 131042,
     "plain_language": "...", "who_fixes": "client", "severity": "critical",
     "occurrence_count": 2, "first_seen": "...", "last_seen": "..." }]
  ```
  ```sql
  select m.client_id, c.name as client_name, m.meta_error_code,
         count(*)::int as occurrence_count, min(m.sent_at) as first_seen, max(m.sent_at) as last_seen
  from messages m join clients c on c.id = m.client_id
  where m.status = 'failed' and m.sent_at > now() - ($1::int || ' days')::interval
  group by m.client_id, c.name, m.meta_error_code
  order by last_seen desc
  ```
  (`plain_language`/`who_fixes`/`severity` attached server-side per row via `metaErrorCatalog`, same as Part B, not left for the admin frontend to guess at.) Already `requireAdminAuth()`-gated — `/api/admin` is mounted with that middleware for the whole router (`app.js:154`), no new auth work needed.
- **Files touched**: `server/src/routes/admin.js` (new route, alongside the existing `/failures/sends`/`/failures/webhook-deliveries`); `admin/app.js` (`loadFailures()` fetches the new endpoint too, new `renderFailuresByErrorCode()`); `admin/index.html` (new table in the existing `#view-failures`-equivalent section — reuse the Failures view's existing tab/section, don't create a competing nav item).
- **Relationship to the existing alerting system, stated explicitly so this isn't read as a duplicate**: `alertRunner.js` already proactively *pushes* two narrow conditions (`checkAuthClassErrors` for 190/10 only, `checkFailedSendSpike` for a global threshold) to Wasi staff via `alertNotifier`. This new endpoint is the *pull* half — a Wasi staffer can check it any time, for every code, not just the two currently alerted on, and see it before a client reports it (your stated goal) even for a code that never crosses an alert threshold. Part D's consistency fix (`accountWideCodes()`) is what keeps both halves reading from one table instead of drifting.
- **Verify**: seed a schema-shaped test fixture with mixed failures across 2 test clients and 3 error codes, confirm the endpoint returns correct per-(client, code) counts and correct `first_seen`/`last_seen`; confirm `plain_language`/`who_fixes` match Part D's table exactly; real browser check the admin Failures tab renders the new grouped table above the existing flat list. Pass: new `server/test/adminFailuresByErrorCode.test.js` green.

---

**Production safety for this item specifically** (6 live clients, read-only DB access only, per your instruction): every query above is a plain `SELECT`, either ad-hoc (Parts A/B, computed at request time, already how `/whatsapp/status` and the chat message list work today) or behind a new admin-only `GET` route (Part C, same shape as the existing `/failures/sends`). **One migration is now proposed** (the `error_detail` column above, added per your first instruction this round) — a single additive nullable column, `ADD COLUMN` only, no `UPDATE`/`DELETE`/backfill of any existing row, and (per your second instruction) its number isn't claimed here — I'll write the file with the real next-available number checked against the migrations directory at build time, not guessed now while Phase D is still consuming numbers concurrently. Beyond that one file, this item still proposes no production `UPDATE`/`DELETE` outside a migration you run yourself. The rest of the production-facing change is new route/response-shape code and frontend rendering — exercised against a schema-shaped local test fixture only, per every `Verify` section above, never against the 6 real clients' data, matching this plan's existing Production safety section.

**Build order**: D → (A, B, C in parallel — none of the three depend on each other, only on D).

---

### 25. Embedded Signup: server-side WABA/phone discovery + a real "Meta linked it, we never got the code" state

**Depends on**: nothing structurally. Directly informs item 26 (v4 migration) — build this first, since it's a safety net that works the same regardless of Embedded Signup version, and de-risks the version migration once it lands.

**Trigger**: the confirmed root cause behind Know Mind/RD interblocks' zero-trace failures (`4a66c2d`, 2026-09-05) was narrower than the full picture. Two real, separate architectural facts, confirmed against Meta's own current documentation plus one independently-corroborated third-party source (`dualhook.com/docs/whatsapp-embedded-signup-guide`), change the fix:

1. **`phone_number_id` is *routinely* absent from the Coexistence `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` event** — confirmed independently by both Meta's own docs (quoted verbatim in this file's history above) and the third-party guide. The merge fix (accumulating fields across every `postMessage`) still correctly catches it *when* Meta sends it on a different message — but there's no guarantee Meta sends it on *any* message. Trusting the popup's data at all is the fragile part, not just how it's read.
2. **The OAuth `code` (via `FB.login`'s callback) and the WABA/phone IDs (via `postMessage` from `facebook.com`) are two independent return channels that can arrive out of order, or one without the other.** Direct quote: *"Do not treat FINISH as success. FINISH means Meta linked the account. It does not mean the authorization code reached your server. Those are different outcomes with different recoveries."* This is a **third** failure mode, distinct from both bugs already found this session (missing field on FINISH; the 10-minute `LOGIN_TIMEOUT_MS` firing before `FB.login`'s callback ever resolves) — and this app currently has **no state for it at all**. Right now, if `FINISH` arrives (Meta really did link the account) but `code` never does, `embeddedSignup.js`'s `connect()` still just throws the generic timeout error — the account sits linked on Meta's side while Wasi shows nothing, with no distinct signal telling anyone that specific thing happened.

**Sourcing honesty, since this plan is about to be built from it**: finding 1 above and the `debug_token`/`granular_scopes` discovery mechanism below are corroborated by *both* Meta's own docs and the third-party guide — solid. The specific claim that `featureType: "whatsapp_business_app_onboarding"` must still be passed manually even under a v4 Builder config (item 26) is sourced **only** from the third-party guide — Meta's own implementation page, fetched directly, explicitly does not cover Coexistence or v4's asset/product configuration model in what's publicly indexed. Flagged here, not silently treated as equally certain, and re-flagged in item 26 below.

---

#### Part A: server-side discovery, replacing "trust the popup" as the primary source of truth

- **What**: once `POST /whatsapp/connect` has a real `code` (regardless of whether the popup ever sent `waba_id`/`phone_number_id`), exchange it for a token as today, then — if `waba_id` or `phone_number_id` is missing — discover them from Meta directly instead of failing. This is strictly additive to the exchange steps already in place; nothing about the token exchange itself changes.
- **The exact mechanism, per both sources**:
  1. `GET /debug_token?input_token=<long-lived token>&access_token=<META_APP_ID>|<META_APP_SECRET>` — read the response's `data.granular_scopes`, find the entry with `scope: "whatsapp_business_management"`, read its `target_ids` array. These are the WABA ids Meta itself says this token is actually scoped to — "ground truth when the postMessage never arrived," not inferred from anything the browser sent.
  2. For the resolved WABA id(s), `GET /{WABA-ID}/phone_numbers?access_token=<long-lived token>` — a real, officially-documented Meta endpoint (confirmed independently, not just via the third-party guide) — to enumerate phone numbers under each.
- **Auth pattern, matching existing precedent in this exact file**: `debug_token`'s `access_token` param authenticates as the **app** (`{META_APP_ID}|{META_APP_SECRET}`), not the per-client token being inspected — this is a new shape for `metaClient.js`, but not a new *credential*: `exchangeCodeForToken`/`exchangeForLongLivedToken` in that same file already use `META_APP_ID`/`META_APP_SECRET` this way. `listPhoneNumbers` uses the ordinary per-client long-lived token, same as every other call in the file.
- **Multiple WABAs or multiple phone numbers — stated explicitly, not guessed**: this app's entire schema already assumes one meaningful WABA per client (`wabasRepo.findByClientId` takes `order by created_at desc limit 1`), so if discovery resolves to exactly one WABA and exactly one phone number, proceed automatically — identical to the popup-supplied case today. **If `target_ids` (or a WABA's phone number list) has more than one entry, do not guess.** No real client's data investigated this session showed more than one WABA or phone number, so there's no evidence this needs solving now — record the ambiguous discovery result (candidate ids, in a new column, see Schema below) and surface it to admin for manual resolution. Auto-picking "the first one" would silently connect the wrong number for a business that has more than one WhatsApp line — worse than failing loudly.
- **What happens to the route's existing behavior**: everything downstream of having a confirmed `waba_id`/`phone_number_id` (subscribe app to WABA, conditionally register the phone number, fetch phone number details, persist `status: 'connected'`) is **unchanged** — discovery only changes how those two ids are obtained when the popup didn't supply them, not anything after.
- **Read-only Meta calls this adds, and failure handling, per your explicit ask**:
  - `GET /debug_token` — read-only, no side effects on Meta's side.
  - `GET /{WABA-ID}/phone_numbers` — read-only, no side effects.
  - Both wrapped in their own try/catch, independent of the main connect try/catch: if discovery itself fails (a transient Meta-side error, a network blip), the route falls back to the **existing** audited failure this session already shipped (`"Meta never sent a phone number ID..."`, `wabas.status='failed'`, `whatsapp_connect_failed` audit row) — discovery is a best-effort additive fallback, never a new hard dependency that could itself introduce a fresh failure mode. Verified this needs no new scopes: `whatsapp_business_management`/`whatsapp_business_messaging`/`business_management` are already requested by this app's existing Embedded Signup config.
- **Files touched**: `server/src/utils/metaClient.js` (new `debugToken(inputToken)`, `listPhoneNumbers(wabaId, accessToken)`); `server/src/routes/onboarding.js` (`/whatsapp/connect`'s try block gains the discovery branch, only entered when `waba_id`/`phone_number_id` is missing).
- **Schema** — one new nullable column, additive, no backfill:
  ```sql
  ALTER TABLE wabas ADD COLUMN connect_diagnostics jsonb;
  ```
  Stores the raw discovery outcome (candidate WABA `target_ids`, candidate phone numbers, which branch was taken — auto-resolved vs. ambiguous) for admin/support debugging, matching this codebase's existing precedent of capturing raw diagnostic payloads (`metaWebhook.js`'s `handleUnmappedWabaEvent`). Not required for the mechanism to function — purely a debugging aid — so genuinely optional if you want to cut scope further.
  **down()**: guard — refuse if any `wabas.connect_diagnostics` is non-null (real diagnostic history for a live client's connection).
- **Verify**: stub `metaClient.debugToken`/`listPhoneNumbers`, send a connect request with `code` but no `waba_id`/`phone_number_id`, confirm discovery resolves a single WABA/phone and completes the connect exactly as a popup-supplied one would; simulate discovery returning 2 WABA `target_ids`, confirm the route records the ambiguous state rather than picking one; simulate `debug_token` itself throwing, confirm the route falls back to the existing audited-failure path unchanged. Pass: new `server/test/onboardingServerSideDiscovery.test.js` green, existing `server/test/api.test.js` onboarding tests still green.

---

#### Part B: a real, recorded state for "Meta linked it, we never got the code"

- **What**: per the direct quote above, `FINISH` and "code reached the server" are independent outcomes. Today, if `code` never arrives (the `LOGIN_TIMEOUT_MS` path, or the popup closing before `FB.login`'s callback fires), `embeddedSignup.js`'s `connect()` throws its generic timeout error even if a `FINISH`-type `postMessage` with a real `waba_id` already arrived — that signal is silently discarded, and there is currently no way to tell "never even started" apart from "Meta actually linked the account, but we lost the handoff."
- **Frontend change**: `connect()`'s catch/timeout path now checks whether `sessionData`/`terminalEvent` already captured a `FINISH`-type event (with a `waba_id`) before rethrowing the timeout error. If it did, `connect()` resolves into a distinct shape — `{ incomplete: true, waba_id }` (no `code`, since none exists) — instead of throwing. If no `FINISH` was ever seen either, it still throws the existing "no WhatsApp account details arrived" error, unchanged (that's the genuine "nothing happened" case, not this one).
- **New endpoint**: `POST /api/onboarding/whatsapp/connect-incomplete`, body `{ "waba_id": "..." }` (no `code` — there isn't one to send, and the schema doesn't accept one for this route on purpose, so it's structurally impossible to confuse with a real connect attempt). `requireClientAuth`, matching `/whatsapp/connect`. Writes `wabas.status = 'incomplete_meta_linked'` (verify no existing `CHECK` constraint on `wabas.status` blocks a new value before writing this migration — none was found in the schema read this session, but re-confirm at build time, not assumed) and a new `whatsapp_connect_incomplete` audit_log entry. Returns `200 { recorded: true }`; the frontend then shows a specific message — *"Meta linked your WhatsApp account, but the connection didn't complete in this browser. Please try again — if it happens repeatedly, contact support."* — not the generic failure toast.
- **What admin's "Retry Provisioning" does with this state, per your explicit ask**: today it requires `waba.access_token_encrypted` to already exist (it re-pulls phone number details for an *already-connected* WABA) — structurally, there is nothing to "retry" for `incomplete_meta_linked`, since no token was ever obtained (no `code` means no token exchange ever ran). `admin.js`'s `retry-provisioning` route gets one new branch: if `waba.status === 'incomplete_meta_linked'`, return a distinct, honest message — *"Meta linked this account but never handed back an authorization code — there's nothing to retry from admin. The client needs to reconnect via Settings > WhatsApp."* — instead of today's generic "No WhatsApp connection to retry" (which reads identically for this state and for "never attempted at all," and shouldn't). Admin's Client Detail page (`admin/app.js`/`admin/index.html`) renders this state distinctly too, not lumped in with "No WhatsApp Business Account connected yet."
- **Files touched**: `embeddedSignup.js` (the incomplete-resolution branch); `app.js`/`marketing/signup.js` (detect `result.incomplete`, call the new endpoint, show the specific message); `server/src/routes/onboarding.js` (new route); `server/src/routes/admin.js` (`retry-provisioning`'s new branch); `admin/app.js`, `admin/index.html` (Client Detail rendering).
- **Verify**: simulate (via a stubbed `window.FB.login` that never calls back, plus a dispatched `FINISH` `postMessage`) the exact race — confirm `connect()` resolves `{incomplete: true, waba_id}` rather than throwing; confirm `POST /whatsapp/connect-incomplete` writes the row and audit entry; confirm admin's retry-provisioning returns the new distinct message for this state, and the existing message unchanged for a client with literally no `wabas` row. Pass: new `server/test/onboardingIncompleteState.test.js` green.

---

**Production safety for this item**: two new nullable/additive schema pieces (`wabas.connect_diagnostics jsonb`, new `wabas.status` value `'incomplete_meta_linked'` — no `CHECK` constraint change identified as needed, confirm at build time), one new route, both new Meta calls are read-only with fallback-on-failure to already-shipped behavior. No production `UPDATE`/`DELETE` outside a migration you run yourself, matching this plan's standing convention. Migration number not claimed here, per your standing instruction while Phase D is still consuming numbers concurrently — check the real next-available number at build time.

**`LOGIN_TIMEOUT_MS` is deliberately left untouched by this plan** — per your explicit instruction, widening it would destroy the diagnostic value of the next real attempt. Part B's incomplete-state handling makes the timeout firing *recoverable and visible* instead, which is a better fix than a longer timeout would be on its own regardless of whether Meta's real sync time is the actual cause.

---

### 26. Embedded Signup v4 migration — scoped only, hard external deadline

**Depends on**: item 25 (server-side discovery is version-independent and is the safety net this migration should land behind, not the other way around).

**The deadline, confirmed directly from Meta's own current documentation** (`developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation`, fetched directly this session, not assumed): *"Embedded signup v2 will be deprecated on October 15, 2026."* Today is 2026-09-07 — roughly 5 weeks. This app currently requests `sessionInfoVersion: '3'` (`embeddedSignup.js`'s `extras`), which per the version table below is the transitional config — not yet on v4.

| Version | Configuration | Status |
|---|---|---|
| v2 | Assets/permissions declared in the `FB.login` call itself | Deprecated 2026-10-15 |
| v3 | `extras.version: "v3"` / `sessionInfoVersion: '3'` opt-in — **this app's current state** | Transitional, same deadline |
| v4 | Assets, permissions, and products declared in the Embedded Signup **Builder** configuration (a Meta App Dashboard-side setup, not just a JS config change) | Current |

- **What this actually requires**: not just a code change — a new or reconfigured Embedded Signup Builder configuration in the Meta App Dashboard (external to this repo), likely a new `config_id`, plus updating `embeddedSignup.js`'s `FB.login()` call to match v4's expected shape. `server/src/routes/onboarding.js`'s `GET /config` (which hands `appId`/`configId` to the frontend) may need to return a different `configId` if v4 requires a distinct one.
- **The real risk — now independently confirmed against Meta's own documentation, 2026-09-07, not just the third-party guide.** Two separate official Meta pages corroborate this from different angles: `.../embedded-signup/implementation` states permission/asset configuration in v4 lives in the App Dashboard's Facebook Login for Business configuration ("defines which permissions to request... from business customers who access Embedded Signup") — but explicitly does **not** mention Coexistence, `featureType`, or a launch selector anywhere on that page (fetched directly and checked for exactly this — genuinely absent, not overlooked). Separately, `.../embedded-signup/onboarding-business-app-users` — Meta's own Coexistence-specific page — states plainly: *"To enable WhatsApp Business app onboarding, add a `featureType` property set to `whatsapp_business_app_onboarding` to the `extras` object in the launch method and callback registration portion of the Embedded Signup implementation code."* Read together, these two pages independently corroborate the third-party guide's original claim: `featureType` is a **launch-call (JS-side) parameter**, never described as something the Dashboard-side Builder configuration carries or replaces. This app unconditionally requests it today (`embeddedSignup.js`'s `featureType` is never conditional) — if a v4 migration ever drops that line under the belief that Builder-based permissions cover it, every future Coexistence client (an unknown but nonzero fraction of real onboardings — Fortune Innovatives confirmed one) would silently lose the QR/history-sync option with no error, no audit trail, nothing — the same *class* of silent failure this whole investigation has been chasing, just relocated. **One more real, independently-confirmed wrinkle found in this same pass**: Meta's own Coexistence page states *"coexistence is no longer a valid `extras.featureType` value, you must use `whatsapp_business_app_onboarding`"* — i.e., this exact parameter has already been renamed at least once in this feature's history. This app already uses the current, correct value, but it's concrete evidence this specific config surface changes over time and deserves the real-flow verification below, not an assumption that today's shape is permanent.
- **Verification plan before pointing production at v4** (per the third-party guide's own recommendation, which matches this codebase's testing philosophy regardless of source): validate the new configuration against **both** a plain Cloud API onboarding **and** a Coexistence onboarding — including the QR/history-sync branch — before cutover. Item 25's server-side discovery, once built, is the safety net if v4's popup behavior changes in some other undocumented way.
- **Files touched (once actually built — not now)**: `embeddedSignup.js` (`extras`/version config); Meta App Dashboard Embedded Signup Builder configuration (external); possibly `server/src/routes/onboarding.js`'s `GET /config` if `configId` changes; `server/src/app.js` if `META_CONFIG_ID` needs to become version-specific.
- **Timeline**: start with enough buffer to test both flows live well before 2026-10-15 — not at the deadline. Recommend targeting early October for the actual cutover so a real problem found in testing still has time to be fixed.
- **Verify (once built)**: a real Playwright/manual pass through both a plain migration signup and a Coexistence signup (QR scan included) against the new v4 config, in a real Meta test environment, before any production client sees it — this cannot be meaningfully unit-tested, since the thing being verified is Meta's own popup behavior under a new configuration.
- **Findings, 2026-09-09/10 — two corrections to the analysis above, code re-read + Meta's docs re-fetched fresh (with cache-busting, after a first fetch turned out to be stale/cached) rather than trusted from an earlier pass:**
  1. **`featureType` stays in `extras` for v4 Coexistence — the "empty extras" reading floated in an earlier draft of this investigation was wrong, not this item's own text above (which already argued correctly for keeping it).** Meta's "Versions" comparison page shows the headline v4 code example as `extras: {}`, but a separate `featureType` reference table on the *same* page states explicitly, verbatim: *"For v3 and v4: `whatsapp_business_app_onboarding` — Enables WhatsApp Business App onboarding custom flow."* Read together: `extras: {}` is the plain/non-Coexistence migration shape; Coexistence still needs `featureType` set under v4 too. Current code (`embeddedSignup.js`, already on `master`) sends `extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding' }` — this is very likely already correct for v4 as-is, not something to strip. Also confirmed current code has already dropped `sessionInfoVersion` and bumped `FB.init` to `version: 'v25.0'` (both landed 2026-09-07/08, ahead of this item ever being formally built — see CLAUDE.md Known Gaps), so the "This app currently requests `sessionInfoVersion: '3'`" line above is stale; today's actual gap is narrower than this item originally scoped.
  2. **`account_update` webhook subscription confirmed, both from code and real delivered events.** `wabaConnectionService.completeWabaConnection` calls `metaClient.subscribeAppToWaba` (→ `POST /{wabaId}/subscribed_apps`) unconditionally on every connection; `metaWebhook.js`'s `WABA_SCOPED_FIELD_HANDLERS` has a real, working `account_update` handler. Field-level Dashboard subscription (not visible in code) is confirmed active by real evidence, not assumed: CLAUDE.md's own 2026-09-08 entry records 8 real `account_update` webhooks Meta actually delivered for a live WABA. Relevant because Meta's docs state Coexistence clients can be auto-offboarded on a device change, and automatic re-onboarding depends on this field — already working today, nothing to build here.
  - **Net effect on scope**: given both of the above, this item may be much smaller than "a new Builder config plus a JS rewrite" — possibly just confirming/declaring the right version marker (Meta's docs show `v3` and `v4-public-preview` both using an explicit `extras.version` key; plain v4 shows none at all, so it's not yet settled whether our code needs one added, or whether config_id's own Builder-vs-legacy origin is what actually determines version behavior). This still needs the live Builder-UI check (point 2 of the original investigation — open `1492366918791604`'s configuration and see whether Coexistence is a selectable option there) before the real code diff, if any, can be scoped precisely.

---

### 27. Client-facing multiple-WABA resolution picker (+ admin picker name/phone enrichment)

**Depends on**: item 25 (server-side discovery + `needs_manual_resolution` state, already built).

- **What**: today, when discovery finds more than one candidate WABA (`connect_diagnostics.reason === 'multiple_wabas'`), the only way to resolve it is an admin picking blind between raw Meta WABA IDs on the Client Detail page — but the client is the one who actually knows which WhatsApp number is theirs. This item moves the picker into the client's own signup flow, showing each candidate's real name and phone number (not a raw ID) so they can pick correctly and finish connecting in the same session. The admin picker stays as a fallback (support-assisted, or the client never returns) — and gets the same name/phone enrichment, closing its own identical bare-ID gap, found while scoping this item (`admin/app.js`'s `renderWabaResolutionHtml`, line 749, renders `wabaTargetIds` as literal `<option value="${id}">${id}</option>` today).
- **Real gap found while scoping, not assumed**: neither of the two pieces this needs exists yet. `metaClient.js` has no WABA-name lookup at all (only `getPhoneNumberDetails`, scoped to phone numbers). `wabaConnectionService.discoverWabaAndPhoneNumber` returns the moment it finds >1 candidate (`wabaTargetIds` straight from `debugToken`'s `granular_scopes`) — it never calls `listPhoneNumbers` per candidate either. So both name and phone number need new enrichment work, not just new UI.
- **New**: `metaClient.getWabaDetails(wabaId, accessToken)` — `GET /{waba-id}?fields=name`, same shape as the existing `getPhoneNumberDetails`. A new shared helper (`wabaConnectionService.enrichWabaCandidates(wabaTargetIds, accessToken)` or similar) calls `getWabaDetails` + the existing `listPhoneNumbers` per candidate and returns `[{ wabaId, name, phoneNumber }]` — used by **both** call sites below, so the enrichment logic exists exactly once. A candidate whose enrichment call fails (revoked access, rate limit) still appears with `name: null`/`phoneNumber: null` and its raw ID as literal fallback text — never silently dropped, matching this codebase's "never fabricate, never hide a failure" convention.
- **Endpoints**:
  - `GET /api/onboarding/whatsapp/pending-resolution` (new, `requireClientAuth`, own `req.clientId` — no `:id` param, matching every other route in `onboarding.js`) → if the caller's own `wabas` row is `needs_manual_resolution`/`multiple_wabas`, decrypts the stored token, calls `enrichWabaCandidates`, returns `{ candidates: [...] }`. `404` if nothing pending.
  - `POST /api/onboarding/whatsapp/resolve-waba` body `{ wabaId }` (new) → same validate → decrypt → auto-resolve-phone-if-exactly-one → `completeWabaConnection(req.db, req.clientId, ...)` shape as admin's existing `resolve-waba` route, adapted to `req.clientId`/`req.db` instead of `:id`/`pool`. `completeWabaConnection` itself is unchanged — already caller-agnostic (its own header comment says exactly this).
  - `GET /api/admin/clients/:id` (existing, `admin.js:87`) — extended: when `waba.status === 'needs_manual_resolution'` and `reason === 'multiple_wabas'`, calls the same `enrichWabaCandidates` before responding, so `renderWabaResolutionHtml` gets names/phone numbers to render instead of bare IDs. One extra call site into the same shared helper, not a second implementation.
- **Files touched**: `server/src/utils/metaClient.js` (new `getWabaDetails`), `server/src/services/wabaConnectionService.js` (new `enrichWabaCandidates`), `server/src/routes/onboarding.js` (2 new routes), `server/src/routes/admin.js` (extend `GET /clients/:id`), `app.js` + `index.html` (new picker UI, wired into the existing connect-failure handler), `marketing/signup.js` + `marketing/signup.html` (same picker, second surface), `admin/app.js` (`renderWabaResolutionHtml` renders name/phone instead of bare IDs — no new admin endpoint needed, just consumes the now-enriched `waba.connect_diagnostics`... or the enriched candidate list, whichever shape `GET /clients/:id` ends up returning it under).
- **Race with the admin fallback**: already safe with no extra work — both routes gate on `status = 'needs_manual_resolution'`, so whichever side (client or admin) resolves first flips it to `connected` (or the `multiple_phone_numbers` sub-state), and the other side's next action just gets the existing "not in that state" 400/409 it already handles.
- **Verify**: stub Meta so discovery returns 2 candidate WABAs; confirm `GET /pending-resolution` returns both with real name+phone; confirm picking one calls `completeWabaConnection` and `wabas.status` becomes `connected` in the same test; confirm a candidate with a failed enrichment call still appears (name null, id visible) rather than being dropped; confirm `GET /api/admin/clients/:id` now returns enriched candidates too, and the admin picker renders names/phones, not raw IDs; confirm the admin fallback route still resolves correctly if the client never acts (existing `resolveWaba` tests unaffected).
- **Size**: medium — no schema/migration change, and the hard part (`completeWabaConnection`) is already done and reused as-is. The real work is the shared enrichment helper (2 new Meta read calls per candidate, called from 2 backend sites) plus new picker UI on two separate frontend surfaces (nothing to adapt client-side — confirmed zero existing special-casing for this state in either `app.js` or `marketing/signup.js` today) plus the smaller admin-side rendering change.

---

### 28. Per-recipient broadcast detail view (drill into one campaign)

**Depends on**: item 24 Part D (`metaErrorCatalog.js`, the `meta_error_code` → plain-language table) for the failure-reason wording — see the fold-vs-separate note below. Structurally independent of everything else.

**Plan only, per your instruction — not built this pass.**

- **What**: today `GET /api/broadcasts` (`broadcastsRepo.list`) only returns aggregate counts per campaign (`recipient_count`, `delivered_count`, `skipped_*_count`, `delivered_rate`, `read_rate`) — there's no way to see any individual recipient. This adds a drill-down: click a campaign in the Campaigns view, see every recipient with their contact name/phone, per-recipient status, and — for a failure — the reason in plain language, not a raw Meta code. Plus a status filter, an export, and a way to retry just the failures.

**Fold vs. separate, your call requested — recommendation: keep separate, make this depend on item 24 Part D.** Item 24 is scoped to three specific surfaces — the chat-message bubble (Part A), an account-wide banner (Part B), and admin's cross-client health view (Part C) — none of which is a single campaign's own recipient list. This item's real net-new scope (contact identity per row, delivered/read status per row — not just failures, a status filter, CSV export, a bulk retry action) has no overlap with any of those three parts at all. The only shared piece is wanting the same `meta_error_code` → plain-language text, which is exactly what Part D's shared module is for — a dependency, not a reason to merge two differently-shaped features (one a campaign drill-down, the other message/account/admin visibility) into one oversized item. If item 24 hasn't shipped by the time this is built, build Part D first (it's already fully scoped, small, and structurally first in item 24's own build order too) and have this item's backend import it — never a second, hand-duplicated code→text table.

#### Part A: `GET /api/broadcasts/:id/recipients` — per-recipient list, paginated + filterable

- **What**: new endpoint, `requireRole('Admin', 'Manager')` matching every other `broadcasts.js` route. Joins `broadcast_recipients` to `contacts` (name/phone — `left join`, so a since-deleted contact still shows using whatever `contact_name`/`contact_phone` reasoning `claimBatch` already applies elsewhere) and to `messages` (status/`meta_error_code`/`error_reason`/`sent_at`) — same join shape `broadcastsRepo.list`'s lateral subquery already uses for its aggregate counts, just returning rows instead of a count.
- **Query params**: `status` (one of `sent|delivered|read|failed|skipped|pending`, optional — filters server-side, not client-side, since a campaign can have thousands of recipients), `limit`/`cursor` (or plain `offset`, matching whichever pagination convention `contact_lists`/segment endpoints already use in this codebase — reuse that, don't invent a third).
- **Per-row shape**:
  ```json
  {
    "recipientId": "...", "contactId": "...", "contactName": "...", "contactPhone": "...",
    "status": "failed",
    "readStatus": "unknown_not_read",
    "metaErrorCode": 131026, "plainLanguageReason": "...", "errorDetail": "...", "errorReason": "...",
    "sentAt": "...", "deliveredAt": null, "readAt": null
  }
  ```
  `readStatus` is a small derived enum computed server-side once (`sent` / `delivered_read_unknown` / `read` / `failed` / `skipped` / `pending`) — never left for the frontend to infer from raw timestamps, so the "read receipts only fire if the recipient has them enabled" caveat is baked into the vocabulary itself (`delivered_read_unknown`, not `not_read`) rather than only living in a UI tooltip that a future screen could omit.
- **Plain-language reason**: `plainLanguageReason` resolved via `metaErrorCatalog.describe(metaErrorCode)` (item 24 Part D) when `status === 'failed'` and a code exists; `null` otherwise. `errorReason` (raw) and `errorDetail` (item 24's richer field, if it exists yet) are still included alongside it, same "never hide the raw text, only add plain language next to it" convention Part D itself establishes.
- **Files touched**: `server/src/routes/broadcasts.js` (new route), `server/src/repositories/broadcastRecipientsRepo.js` (new paginated/filtered list query) or a small new read-only helper alongside it.

#### Part B: Campaigns UI — recipient detail panel

- **What**: clicking a campaign row in the existing Campaigns view opens a panel/modal listing its recipients — contact, status badge, and (for failures) the plain-language reason with the raw text still available on hover/expand (matching item 24 Part A's own "plain language visible, raw text kept, not dropped" convention). A status filter (All/Sent/Delivered/Read/Failed/Skipped/Pending) narrows the list via Part A's `status` param. A one-line legend near the Read column states the caveat plainly: delivered-but-not-read means WhatsApp read receipts are off or unknown for that contact, not that the message was ignored.
- **Files touched**: `app.js` (new panel render + fetch, paginated), `index.html` (new modal/panel markup + a small status-badge/legend CSS block, matching existing `.msg-status`-style conventions).

#### Part C: CSV export of the (filtered) recipient list

- **What**: an "Export" button on the recipient panel that downloads the currently-filtered list (respecting the `status` filter already applied) as CSV — contact name, phone, status, reason. Reuses whatever CSV-generation convention this codebase's existing exports use (checked at build time — `contact_lists`/broadcast CSV-import already exists on the import side; confirm the matching export-side pattern rather than inventing a new one).
- **Files touched**: likely a new `GET /api/broadcasts/:id/recipients/export.csv` (server-generated, so it isn't capped by whatever page size the panel fetches) rather than a client-side CSV built from only the currently-loaded page.

#### Part D: Retry failed recipients

- **What**: a "Retry failed" action, scoped to the recipients currently showing as `failed`, either all-at-once or one row at a time. Deliberately **not** a new send code path — resets the targeted `broadcast_recipients` row(s) back to `status='pending'`, `message_id=null`, `error_reason=null` (mirroring exactly the shape `claimBatch` already expects a fresh row to be in), and lets `broadcastRunner`'s existing 5-second tick pick them up and resend through the one real send pipeline every other path already uses — no bespoke retry-send logic to get wrong.
- **New endpoint**: `POST /api/broadcasts/:id/recipients/retry-failed` (optionally scoped to specific `recipientIds` in the body for a single-row retry, defaulting to "every currently-failed recipient" when omitted).
- **A real edge case to design around, not ignore**: a broadcast already sitting at `status='Completed'` (every recipient resolved, none pending/sending — see `hasPending`) needs to flip back to `'Sending'` when a retry re-queues at least one recipient, or the runner's `listActive()` (`where status = 'Sending'`) will never pick the retried rows back up at all. This endpoint must call `broadcastsRepo.markStatus(db, id, 'Sending')` whenever it re-queues anything.
- **Files touched**: `server/src/routes/broadcasts.js` (new route), `server/src/repositories/broadcastRecipientsRepo.js` (new `resetToPending` function), `app.js`/`index.html` (the retry button + confirmation, since this sends real WhatsApp messages — per this project's own standing rule to confirm before any real send, the UI should say plainly "this will resend to N contacts" before firing).

**Size**: large overall (4 parts touching a new endpoint family, a new UI panel, an export path, and a real re-send action) — but each part is independently small-to-medium and shippable on its own; Part A is the only hard dependency for B/C/D. Suggested build order: A → (B, C in parallel) → D (D's "flip back to Sending" edge case is easiest to get right once A's status vocabulary already exists to reset into).

**Verify (when built)**: seed a schema-shaped test broadcast with a mix of sent/delivered/read/failed/skipped/pending recipients (never against the 6 real clients' data, matching every other item's production-safety convention in this file) — confirm Part A's endpoint returns correct per-row shape and correctly filters by `status`; confirm `readStatus` never claims `read` for a delivered-only message; confirm Part D's retry flips a `Completed` broadcast back to `Sending` and the *existing* `broadcastRunner` test harness picks the reset row up on its next `processBroadcast` call (not `.tick()`, per this file's own shared-live-database convention); real browser check (Playwright) that the panel renders, the filter narrows the list, and the read-receipt caveat text is visible.

---

## Assumptions made

1. "Codebase wins" extends to terminology — every item uses `client_id`/`clients`, never the spec's `tenant_id`/`tenants`.
2. Every new tenant table gets the exact RLS/grant treatment as every existing tenant table (migrations `013`/`023`/`039` pattern) — no exceptions proposed.
3. Team-member login (item 1) reuses the existing JWT/bcrypt mechanism, no new session store.
4. No plan item hardcodes a number from the reference spec that looks like real business data (Meta pricing, tier thresholds) — item 13 is TODO-gated per your instruction, item 15 ships empty for admin entry.
5. `admin`-mounted routes (`requireAdminAuth()`) and Hub API v1 (`requireApiKey`) are entirely out of scope for the team-member role work in item 1 — those are different credential types altogether, structurally unreachable by a `team_member` JWT regardless of role.

## Open questions — resolved

All 5 of Revision 2's open questions are resolved by your answers:

1. Owner-only design in item 1 stays as drafted — WABA settings, billing, wallet, client-webhook, API keys, and payment-links stay unreachable by every team-member role, including one titled `Admin`. `Admin`/`Manager` being functionally identical in v1 is accepted, loosenable later.
2. Item 2's backfill uses the 24h-unanswered-inbound signal, not a 7-day window — see item 2 above.
3. Item 2's down() now refuses if any chat has a non-default `status` or non-null `assigned_team_member_id` — see item 2 above.
4. Payment-links stays owner-only.
5. Build order confirmed as `1 → 2,3,4,5 → 6,7,8,9,10 → 11,12,13,14,15,16`, item 11 correctly placed before item 12.

No open questions remain. Revision 3 is approved and Phase D begins below.

---

**Phase D status**: before writing any item-1 code, a real blocker surfaced during setup — see the message accompanying this plan update. Implementation has not started.
