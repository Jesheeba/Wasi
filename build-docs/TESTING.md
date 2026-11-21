# Testing

## settings-forms-admin-redesign (steps 1-2)
`server/test/settingsRedesign.test.js` (Playwright, :4000, local embedded
Postgres via TEST_DATABASE_URL, disposable client deleted in after()):
tags inline add saves the chosen colour and never opens the modal (AC4);
canned drawer live preview, Escape-with-input asks, Cancel keeps text,
Discard clears, clean drawer closes without asking (AC5/6); attribute saves
as `number` (the 400 fix, AC8); 375px no overflow + full-width drawer
(AC9). 5/5 pass. Regression: chatUiPass 15/15 (needs JWT_SECRET set; it
doesn't load .env), confirmPromptGroup23 + modalInnerScrollGroup4 pass.
errorDialogUI test 2 fails identically on the pre-change tree (it predates
the template type picker, 88bc697) - stale test, not a regression.

## flow-editor-shared-tokens
`server/test/flowEditorSharedTokens.test.js` (static, no DB): the editor links
`/breakpoints.css`; every shared-palette `--wf-*` is `var(--token, fallback)`;
no literal colour outside the `:root` block or in the JSX/constants; the app
serves `/breakpoints.css` and the Dockerfile ships it. 4/4 pass; mutation check
(re-adding one `#F9FAFB`) fails the suite as expected. Live check: `createApp()`
on :4000 + Playwright, `/flow-editor/` loads the shared sheet, `--wf-accent` =
`#4AC959`, and overriding `--brand` turned `.wf-btn-primary` red.

## carousel-templates
`server/test/carouselTemplates.test.js` - real DB writes through a
disposable test client (same pattern as `limitedTimeOfferTemplates.test.js`);
every Meta call (createUploadSession/uploadFileBytes/uploadMedia per card +
message_templates) stubbed. Mapped to the feature doc's acceptance criteria:

| Test | Criterion |
|---|---|
| 1-card carousel rejected locally (400) | #2 |
| Mismatched card button shapes across cards rejected locally (400) | #2 |
| Non-Marketing category rejected locally (400) | #2 |
| Header alongside a carousel rejected locally (400) | #2 |
| Card file count must match card count (400), no Meta call | #2 |
| Valid 2-card carousel submits with the documented lowercase `body`/`carousel`/`header`/`buttons` shape (not this app's usual uppercase); one media upload per card; local row stores `cards` with no transient `headerHandle`; one default media asset cached per `card_index` | #1 |
| Sending resolves one media id per card and sends a `carousel` component with per-card `card_index` + header | #3 |

Result: 7/7 pass. Regression: re-ran the full template/broadcast/consent
impact map (`limitedTimeOfferTemplates`, `templateEdit`,
`templateMediaAssets`, `templateSync`, `templateLibrary`,
`templateCategoryMismatchWarning`, `templateLanguageHardcodeFixes`,
`consentTracking`, `consentHardeningPhase1/2`, `optInKeywordPhase4`,
`apiV1AuthenticationTemplateSend`, `broadcastRetry`, `broadcastPacing`,
`broadcastSmartSending`) - 111/111 pass, all pre-existing ones unaffected.

**Known gap, documented not hidden**: `POST /:id/header-media` (uploading
a NEW media asset to an existing template after creation) is not yet
card-aware - only the creation-time per-card upload path works. A
carousel template's card media can only be set at creation; re-uploading
a card's image later needs a future pass, same two-pass history this
app's single-header media-asset feature itself had (`templateMediaAssets.test.js`'s
whole premise). Not a blocker for the acceptance criteria above - just
not built yet.

**Frontend scope note**: the create-modal's per-card editor supports one
optional URL button per card (not the full QUICK_REPLY/PHONE_NUMBER mix
Meta allows) - matches the common "image + text + link" pattern from the
reference screenshot, deliberately simpler than building two full button
editors for a first pass.

## fix(cross-tab-tenant-isolation)
`server/test/crossTabTenantIsolation.test.js` - real browser (Playwright),
two tabs sharing one context/storage, against `wasi-test-postgres`
(port 5433), served on port 4005 with `page.route` redirecting app.js's
hardcoded `:4000` API calls (port 4000 was already held by the user's own
locally-running dev server, left untouched per project convention).

| Test | Criterion |
|---|---|
| Tab A open on account A; tab B (auto-resumes A via shared storage) logs out and into account B | Tab A gets forced back to the login screen, never renders B's data under A's chrome |
| Tab B performing the switch | stays logged in as B, unaffected |
| Tab B re-authenticates as the SAME account with a fresh token (no logout) | Tab A is NOT kicked out - decoded tenant id still matches |

2/2 pass. `confirmPromptGroup23.test.js` (the other test that also
hardcodes port 4000) could not be re-run in this session for the same
pre-existing port-4000 collision already documented in the
limited-time-offer-templates entry above - unrelated to this change, no
diff on that file.

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
| LTO coupon code over 15 chars rejected locally (400) | #2 |
| LTO with no coupon code rejected locally (400) | #2 |
| LTO + footer rejected locally (400), no Meta call | #2 |
| LTO on a non-Marketing category rejected locally (400) | #2 |
| Valid Marketing + LTO (no header) submits to Meta with a `LIMITED_TIME_OFFER` component AND the Meta-required `COPY_CODE` button (`example` = the literal code, not the strip text); local row stores `limited_time_offer` | #1 |
| Sending with `hasExpiration` requires `limitedTimeOfferExpirationMs`; valid value forwarded to Meta as `expiration_time_ms` + the required `copy_code` button component | #3, #4 (via `limited_time_offer_expiration_required` rejection) |

Result: 8/8 pass (grew from an initial 5/5 - 3 more added after a real
Meta submission caught 2 real bugs the stubbed tests couldn't: see the
feature doc's "Correction after real Meta submission" section). Regression:
re-ran every file in the feature doc's impact map plus the template/
broadcast/consent suites most likely to interact - `templateEdit`,
`templateMediaAssets`, `templateSync`, `templateLibrary`,
`templateCategoryMismatchWarning`, `templateLanguageHardcodeFixes`,
`consentTracking`, `apiV1AuthenticationTemplateSend`, `broadcastRetry`,
`broadcastPacing`, `broadcastSmartSending` - 82/82 pass (incl. the 8 LTO
tests), all pre-existing ones unaffected by this change.

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
