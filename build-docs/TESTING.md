# Testing

## client-suspension-paywall
`server/test/clientSuspensionPaywall.test.js` - stubs only (no DB), same
discipline as `sessionInvalidation.test.js`. Mapped to the feature doc's
acceptance criteria:

| Test | Criterion |
|---|---|
| `requireClientAuth`: active/suspended owner both pass, `req.clientStatus` set | widened select doesn't self-block (billing/auth-me depend on this) |
| `requireClientOrTeamAuth`: owner branch sets status from `clients` | #2 |
| `requireClientOrTeamAuth`: team_member branch sets status from the JOINED owning client, not the team member | #3 |
| `requireActiveSubscription`: active passes | #4 |
| `requireActiveSubscription`: `pending_setup` passes (explicitly not gated) | scope decision in feature doc |
| `requireActiveSubscription`: `suspended` → 402 `subscription_suspended` | #1 |

Result: 7/7 pass. Run: `node --test --test-concurrency=1 test/clientSuspensionPaywall.test.js`.

Also re-ran `sessionInvalidation.test.js` (unchanged, 10/10 pass) as the
regression check for `requireClientAuth`/`requireClientOrTeamAuth`, since
those two files were edited directly.

**Known gap, not caused by this feature**: `teamMemberAuth.test.js` and the
other 67 files using `createApp()` for a real HTTP+DB round trip currently
fail under `npm test` - `dbSafety.js`'s guard refuses any DB connection
under a test context without `TEST_DATABASE_URL`, which this project
doesn't have yet. Pre-existing, already tracked
(`project_orphaned_test_clients_cleanup` memory). This meant criteria #5
(live session torn down mid-use) and the full owner/team-member HTTP flow
couldn't be exercised end-to-end here - covered at the middleware-unit
level only, consistent with the one test style that currently works in
this repo.

**Update, 2026-11-16**: this gap is now closable locally - stood up a
disposable local Postgres 17 via `docker run ... postgres:17-alpine` on
port 5433 (exactly `.env.example`'s documented recipe), ran
`node-pg-migrate up` + `db/seed.js` + `db/seedTemplateLibrary.js` against
it, then `npm test` with `DATABASE_URL`/`TEST_DATABASE_URL` both pointed at
it (plus `TEST_ADMIN_PASSWORD` overridden back to the seed default - the
committed `.env`'s `TEST_ADMIN_PASSWORD` is the real rotated production
admin password, which doesn't exist on a fresh local seed). The full
`createApp()`-based suite (101 files) runs for real against this, not just
the stubs-only style. The container isn't part of this repo/commit - it's
a one-off local tool, recreate with the same docker command whenever a
real DB-backed test run is needed.

## limited-time-offer-templates
`server/test/limitedTimeOfferTemplates.test.js` - real DB writes through a
disposable test client (same pattern as `templateMediaAssets.test.js`);
every Meta call stubbed. Run against the local test Postgres above (migrations
091/092 applied there first). Mapped to the feature doc's acceptance criteria:

| Test | Criterion |
|---|---|
| LTO + non-NONE header rejected locally (400), no Meta call | #2 |
| LTO offer text over 16 chars rejected locally (400) | #2 |
| LTO on a non-Marketing category rejected locally (400) | #2 |
| Valid Marketing + LTO (no header) submits to Meta with a `LIMITED_TIME_OFFER` component; local row stores `limited_time_offer` | #1 |
| Sending with `hasExpiration` requires `limitedTimeOfferExpirationMs`; valid value forwarded to Meta as `expiration_time_ms` | #3, #4 (via `limited_time_offer_expiration_required` rejection) |

Result: 5/5 pass. Regression: re-ran every file in the feature doc's impact
map plus the template/broadcast/consent suites most likely to interact -
`templateEdit`, `templateMediaAssets`, `templateSync`, `templateLibrary`,
`templateCategoryMismatchWarning`, `templateLanguageHardcodeFixes`,
`consentTracking`, `apiV1AuthenticationTemplateSend`, `broadcastRetry`,
`broadcastPacing`, `broadcastSmartSending` - 74/74 pass, all pre-existing,
none touched by this change.

Also ran the full 101-file suite once as a final check: 767 tests, 753
pass, 13 fail, 1 skipped. All 13 failures are in files this feature never
touched (confirmed via `git status` - zero diff on any of them) and none
are in the impact map above:
- 11 UI test files (`adminUiRedesign`, `broadcastPauseResumeUI`,
  `chatUiPass`, `confirmPromptGroup23`, `errorDialogUI`,
  `marketingBannersGroup5`, `modalInnerScrollGroup4`, `modalScrollGroup1`,
  `segmentBuilderUI`, `smartSendingUI`, `templateLibraryUI`) all fail with
  the identical pre-existing cause: `app.listen(4000)` (not `listen(0)`
  like the properly-isolated tests) collides with an unrelated process
  already bound to port 4000 on this machine (confirmed via `netstat`/
  `Get-Process` - a node process started independently of this session,
  left untouched rather than killed without knowing what it is).
- 2 subtests (`api.test.js`'s coexistence onboarding case,
  `embeddedSignupConnectRuntime.test.js`'s runtime-1 case) fail with a
  502 instead of 200 - both about WhatsApp Embedded Signup/Coexistence
  connection flows, unrelated to templates/broadcasts/messaging, not
  investigated further here (out of this feature's scope).
