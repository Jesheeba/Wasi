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
