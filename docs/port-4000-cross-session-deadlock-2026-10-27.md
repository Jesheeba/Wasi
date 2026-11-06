# Concurrent test runs deadlock - not a test defect, and not one single cause

**Status:** two confirmed mechanisms, fix not yet applied to either. This has
cost two sessions most of a day - document first, fix later, per direct
instruction.

**The finding is "concurrent test runs against this project deadlock," not
"port 4000 is the problem."** Two independent mechanisms have been directly
observed causing the identical symptom (near-zero CPU, no further output,
hangs indefinitely under `--test-timeout=0`, blocks the rest of that
session's suite behind it because `--test-concurrency=1` runs files
strictly one-after-another): (1) the hardcoded-port collision below, and (2)
contention on the single shared test-database container when two sessions'
test processes hit it at once. Finding and fixing (1) does not mean (2) is
solved, and finding (2) does not mean (1) isn't real - both have been
observed directly, in this exact investigation, on different stuck process
chains. Treat this as an open class of hazard with (at least) two known
instances, not a single root cause with a single fix.

## The symptom

A `node --test --test-concurrency=1` run against the real test database (the
Postgres 17 container stood up this session - see `server/README.md`'s
"Running tests" section) hung indefinitely inside
`server/test/adminUiRedesign.test.js`, with near-zero CPU and no further
output, for roughly 3-4 hours before being found and killed. Confirmed via
direct process inspection:

```
PID 38636: node.exe ... --test-timeout=0 ... test\adminUiRedesign.test.js
  started 2026-10-27 16:12:10
  parent → PID 4216: node.exe --test --test-concurrency=1
  started 2026-10-27 16:12:08
```

Both PIDs were confirmed to belong to this session's own run (not an
unrelated orphan, and not the `fix-test-hang` worktree's process) by
correlating the redirected log file's content - which can only be written to
by the exact process that redirection targets - against the live process's
command line: the log ends mid-file inside `adminUiRedesign.test.js` with no
final tally, matching the live child's current file exactly.

Separately, in the same window, a **different session**, working in
`.claude/worktrees/fix-test-hang/server/`, ran its own full suite and got a
real result: `tests 737 / pass 703 / fail 33`. That run is real but belongs
to a different worktree, different env vars, and a different seed state - it
is not evidence about this session's hang, and the two are not reconciled
against each other.

## Mechanism 1: hardcoded port 4000 (11 Playwright files)

**13 files reference `4000`; 11 of them actually bind it**, every one a
Playwright UI test that opens a real browser against a real running Express
server on a **hardcoded, fixed port**:

| File | Bind call |
| --- | --- |
| `test/adminUiRedesign.test.js` | `createApp().listen(4000)` |
| `test/broadcastPauseResumeUI.test.js` | `app.listen(4000)` |
| `test/chatUiPass.test.js` | `app.listen(4000)` |
| `test/confirmPromptGroup23.test.js` | `app.listen(4000)` |
| `test/errorDialogUI.test.js` | `app.listen(4000)` |
| `test/marketingBannersGroup5.test.js` | `app.listen(4000)` |
| `test/modalInnerScrollGroup4.test.js` | `app.listen(4000)` |
| `test/modalScrollGroup1.test.js` | `app.listen(4000)` |
| `test/segmentBuilderUI.test.js` | `app.listen(4000)` |
| `test/smartSendingUI.test.js` | `app.listen(4000)` |
| `test/templateLibraryUI.test.js` | `app.listen(4000)` |

(The other 2 matches for `"4000"` are false positives: a UUID literal in
`chatsLastAgentReplyAt.test.js` and a comment referencing this exact known
issue in `metaTemplateLibrary.test.js`.)

None of these 11 `listen()` calls has an `'error'` handler attached, and none
uses an ephemeral port. Compare to the pattern already used correctly
elsewhere in this suite - `server/test/adminLoginAudit.test.js`:
`server.listen(0, '127.0.0.1', r)`, reading the real assigned port back from
`server.address().port` - which cannot collide with anything, because the OS
picks a free port.

**`--test-concurrency=1` (added 2026-09-03, documented in this file's
Conventions section) does not and cannot fix this.** That flag serializes
test *files within one `node --test` invocation* - one child process exits
before the next starts, inside a single parent process tree. It has no
effect across two separate invocations started by two separate sessions
(two separate OS process trees, e.g. this session's main-tree run and the
`fix-test-hang` worktree's run). `--test-concurrency=1` solved "two files in
the same run fight over port 4000"; it was never capable of solving "two
*processes* fight over port 4000," because that's not a concurrency setting
within one run, it's a second, independent program racing the first for the
same OS-level socket.

**The deadlock mechanism:** when two sessions each run their own
`node --test` invocation and each eventually reaches one of these 11 files,
whichever process's `listen(4000)` call wins the race binds the port
normally. The other side's `net.Server` either throws an unhandled
`'error'` (`EADDRINUSE` - no listener is attached to catch it, so by
EventEmitter semantics this is an uncaught exception) or, depending on
timing, leaves that file's `before()` hook never resolving its
`server.once('listening', resolve)` promise. Either way, with
**`--test-timeout=0`** (as this session's invocation used - no per-test
timeout, by design, so a genuinely slow real-DB test is never force-killed
prematurely), nothing ever intervenes to kill the stuck file. Because
`--test-concurrency=1` runs files strictly one-after-another, that one stuck
file blocks every file queued behind it - the entire rest of the suite never
runs, with no output and near-zero CPU, exactly matching what was observed.
This reproduces specifically when two sessions run tests concurrently, and
not when a single session runs alone, because a solo run has no second
process competing for the same socket.

**This rules out one specific theory about `metaTemplateLibraryQA.test.js`,
not the whole class of problem.** An earlier theory (from the other
session) suspected a defect in that file's own real-cache backup/restore
logic (documented in CLAUDE.md's Known Gaps as a past, real, separate
incident). That specific file-level defect is not implicated in *this*
collision - it never binds a port at all, so it cannot be the port-4000
mechanism. The other session was right to rule that specific theory out.
**It does not mean the underlying hazard - two sessions' test processes
running concurrently - is solved.** See Mechanism 2 below: the file's own
paired sibling (`metaTemplateLibrary.test.js`) is the one found stuck for
4.5 hours in this same investigation, via a different mechanism.

## Mechanism 2: shared test-database contention

A second, independent stuck process chain was found during this same
investigation - predating this session's own run, started 15:48:37 (before
this session's 16:12 run even began), near-zero CPU, sitting on
`test/metaTemplateLibrary.test.js` for roughly 4.5 hours:

```
PID 24560: node ... npm-cli.js test
  → PID 16572: node --test --test-concurrency=1
    → PID 38268: node ... test\metaTemplateLibrary.test.js
```

**This file does not bind a port at all** - `server = app.listen(0)`, an
ephemeral port, confirmed by reading the file directly. So this hang cannot
be Mechanism 1. What it does do heavily is real `pool.query()` calls against
shared, non-tenant-scoped tables (`meta_template_library_cache`, `clients`,
`message_templates`) on the one shared test-database container every
session's run in this environment ultimately points at. `metaTemplateLibrary
.test.js` and its sibling `metaTemplateLibraryQA.test.js` already have one
documented history of exactly this class of race (CLAUDE.md, Conventions:
"both trigger real admin refreshes against mutually-exclusive fake partial
catalogs on the same shared cache table... `npm test` now forces
`--test-concurrency=1`... which resolved every instance of this found so
far") - but that fix only ever serializes files *within one `node --test`
invocation*. It was never designed to, and cannot, prevent a second,
independent invocation (a second session, its own process tree, its own
`--test-concurrency=1`) from running the identical file against the
identical shared database container at the same time. Two sessions each
correctly serializing their own files internally can still collide with
each other on the same shared Postgres container - row locks, long-held
transactions, or a query waiting on a lock the other session's transaction
holds - which presents identically to the port-4000 hang: near-zero CPU, no
further output, no recovery under `--test-timeout=0`.

**Likely common cause, not confirmed in full detail**: the earlier session
reported running `metaTemplateLibrary.test.js` and `metaTemplateLibraryQA
.test.js` together and getting 15/15 passing - meaning the pairing itself is
fine when nothing else is concurrently touching the same database. The
single variable that changed between that passing run and this stuck chain
is a second session's test process also being active against the same
Postgres container at an overlapping time - the same class of hazard this
session caught itself triggering earlier today (running a single test file
manually while a different full-suite background run was still active
against the same test database, confirmed contaminated and discarded before
being used as evidence for anything).

## The fix for Mechanism 1 (not yet applied)

This closes the port-collision mechanism only. It does nothing for
Mechanism 2 (shared test-database contention), which has no proposed fix
yet beyond the operational rule below - a real fix there would mean either
a separate test database per session/worktree, or some form of
cross-session locking/coordination, neither designed here.

Each of the 11 files above should switch from a hardcoded `listen(4000)` to
an ephemeral port, exactly matching `adminLoginAudit.test.js`'s existing
pattern:

```js
// before
server = app.listen(4000);
await new Promise((resolve) => server.once('listening', resolve));
baseUrl = 'http://localhost:4000';

// after
server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
baseUrl = `http://localhost:${server.address().port}`;
```

This removes the whole class of collision - same-invocation and
cross-session alike - rather than papering over one symptom of it. It needs
no new flag, no coordination between sessions, and no change to
`--test-concurrency=1` (which remains correct and necessary for the
same-invocation shared-database races it already fixes - see Conventions).

`server/test/embeddedSignupConnectRuntime.test.js` (added this session) has
the same anti-pattern on a different fixed port, `4001` - not implicated in
this specific hang, but the identical hazard, and should get the same fix
when this is done.

## Operational rule, effective immediately

**One test run at a time, across all sessions - Playwright or not.** The
port-4000 fix above, even once applied, only closes Mechanism 1. Mechanism
2 (shared test-database contention) can hang a non-Playwright, DB-touching
test file just as silently, with no port involved at all - confirmed
directly by the `metaTemplateLibrary.test.js` chain above. Narrowing this
rule to "Playwright files only" would leave Mechanism 2 live. Before
starting any test run that touches the database: check for another
session's live `node --test`/`npm test` process
(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match
'node --test|npm test' }` or equivalent) and a listener on port 4000
(`netstat -ano | findstr :4000` / `Get-NetTCPConnection -LocalPort 4000`).
If either is present, wait.
