# Client suspension paywall

## Purpose
Admin's "Service Off" toggle (`admin/app.js`) and the payment-reminder
auto-suspend runner (`paymentReminderRunner.js`) both set `clients.status =
'suspended'`, and the admin confirm dialog claims "they will not be able to
use Wasi until Service is turned back on." Confirmed by reading the actual
code: this is false today. Nothing in `requireClientAuth`/
`requireClientOrTeamAuth`/`/api/auth/login` checks `clients.status` at all —
a suspended client can log in and use the full app normally. This feature
makes that claim true, and tells the client why, with a hard block and a
"subscription is over — pay to continue" screen.

## Scope decision (confirming before implementing)
Gates on `status === 'suspended'` ONLY — not `pending_setup`.
`pending_setup` is a separate, already-flagged bug
([project-pending-setup-status-bug](../../..) — memory, 2026-09-23): 5 real,
currently-working clients (Brainlit, RD interblocks, Know Mind, both Sirah
accounts) are wrongly stuck in `pending_setup` despite sending fine. Gating
on it now would show them a false "pay to continue" wall. `suspended` is the
one status this app's own auto-suspend feature and the admin toggle already
produce intentionally and mean as "stop serving this account."
**Needs your confirmation before I implement — flagging again since this
wasn't explicitly settled in your last answer.**

## Architecture
**Server (the actual gate):**
- `requireClientAuth.js` / `requireClientOrTeamAuth.js` already run a `select
  ... from clients where id = $1` on every authenticated request (for
  `token_version`). Add `status` to that same select — no new query.
- If `status === 'suspended'`, short-circuit with `402` + `{ error:
  'subscription_suspended' }`, for every route EXCEPT: `GET /api/auth/me`
  (so the frontend can detect the state at all), `GET /api/auth/team/me`,
  and the existing billing routes (`GET /billing/subscription`, `GET
  /billing/plans`, `POST /billing/checkout`, `POST /billing/coupon`) so a
  self-serve client can actually pay their way out.
  - Team-member requests check the OWNER client's status (already resolved
    via `req.clientId` in the team-member branch), since the client, not
    the team member, is what's suspended.
- A team member has no billing access at all today (billing routes are
  `requireClientAuth`-only, owner-only) — team members just see the block
  with no CTA, which is correct: they can't pay anyway, only the owner can.

**Client (`app.js`/`index.html`):**
- `enterApp(client, actor)` already receives the full client row (includes
  `status`) at both login and session-resume. Add one check at the top: if
  `client.status === 'suspended'`, render a full-screen block instead of the
  normal app shell — skip `loadInitialData`/`startPolling`/nav entirely.
- Block screen: "Your subscription has ended — pay to continue using Wasi."
  - Owner actor: a "Manage billing" button reusing the existing
    `openChoosePlanModal`/Subscription-tab flow (`/api/billing/*` stays
    reachable per above) — no new payment UI, reuse what's there.
  - Team-member actor: same message, no billing button (they can't pay),
    just "Contact your account owner."
  - Always show a "Log out" action (client-side only, no endpoint needed).
- Every other `authFetch` call will now get a `402` the moment status
  flips mid-session (e.g. auto-suspend runner fires while they're logged
  in): `authFetch`'s existing error handling needs one new branch for
  `subscription_suspended` that tears down to the same block screen,
  parallel to how `isAuthError` already tears down to the login screen.

## Impact map
- `server/src/middleware/requireClientAuth.js`, `requireClientOrTeamAuth.js`
  — the actual gate.
- `server/src/routes/billing.js` — confirm its router is mounted with
  `requireClientAuth` (owner-only) so the carve-out only ever reaches an
  owner, never a suspended team member.
- `app.js` — `enterApp`, `authFetch` (new 402 branch), new block-screen
  render function.
- `index.html` — new block-screen markup (hidden by default).
- **Does not touch**: `pending_setup` handling, `wabaConnectionService.js`,
  `messagingService.js`, admin's Service toggle logic (already correct,
  just currently a no-op lie — this feature makes it true).
- Admin side unaffected except the toggle's confirm-dialog wording becomes
  accurate; no admin code change needed.

## Edge cases and failure modes
- Status flips to `suspended` while the client has an open session (not
  just on next login) → covered by the `authFetch` 402 branch above, not
  just a login-time check.
- Status flips back to `active` while they're sitting on the block screen →
  acceptable to require a page reload/re-login; not polling for un-suspend
  (no evidence this needs to be instant — admin can tell the client).
- A suspended owner must still reach `/billing/checkout` to actually pay —
  explicitly carved out, tested as part of acceptance criteria below.
- A suspended client's inbound webhook traffic (`metaWebhook.js`) is
  unauthenticated by clients.status design (webhooks use `requireApiKey`/
  Meta's own signature, not client auth) — correctly untouched; messages
  still land, they just can't be viewed/replied to until un-suspended. Not
  a new decision — just confirming this feature doesn't accidentally touch
  webhook ingestion.
- `pending_setup` clients: explicitly NOT blocked by this change (see scope
  decision above).

## Acceptance criteria
1. A client with `status = 'suspended'` who logs in sees the block screen,
   not the app shell; no chat/contacts/etc. data is fetched.
2. The same client's token can still call `GET /api/auth/me` (200) and
   `GET/POST /api/billing/*` (200), so they can pay. Every other
   authenticated route returns `402 subscription_suspended`.
3. A team-member token under a suspended owner gets the same `402` on
   non-exempt routes; `GET /api/auth/team/me` still works so the frontend
   can show them the "contact your owner" variant.
4. An `active` client is completely unaffected (no new latency-visible
   behavior, no new fields required in the client response beyond `status`,
   which is already returned).
5. A session already open in a browser tab gets torn down to the block
   screen on its next API call after the account is suspended server-side
   (not just on next full login).
