# Port 4000: a cross-session test deadlock, not a test defect

**Status:** root cause identified, fix not yet applied. This has cost two
sessions most of a day — document first, fix later, per direct instruction.

## The symptom

A `node --test --test-concurrency=1` run against the real test database (the
Postgres 17 container stood up this session — see `server/README.md`'s
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
correlating the redirected log file's content — which can only be written to
by the exact process that redirection targets — against the live process's
command line: the log ends mid-file inside `adminUiRedesign.test.js` with no
final tally, matching the live child's current file exactly.

Separately, in the same window, a **different session**, working in
`.claude/worktrees/fix-test-hang/server/`, ran its own full suite and got a
real result: `tests 737 / pass 703 / fail 33`. That run is real but belongs
to a different worktree, different env vars, and a different seed state — it
is not evidence about this session's hang, and the two are not reconciled
against each other.

## Root cause

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
elsewhere in this suite — `server/test/adminLoginAudit.test.js`:
`server.listen(0, '127.0.0.1', r)`, reading the real assigned port back from
`server.address().port` — which cannot collide with anything, because the OS
picks a free port.

**`--test-concurrency=1` (added 2026-09-03, documented in this file's
Conventions section) does not and cannot fix this.** That flag serializes
test *files within one `node --test` invocation* — one child process exits
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
`'error'` (`EADDRINUSE` — no listener is attached to catch it, so by
EventEmitter semantics this is an uncaught exception) or, depending on
timing, leaves that file's `before()` hook never resolving its
`server.once('listening', resolve)` promise. Either way, with
**`--test-timeout=0`** (as this session's invocation used — no per-test
timeout, by design, so a genuinely slow real-DB test is never force-killed
prematurely), nothing ever intervenes to kill the stuck file. Because
`--test-concurrency=1` runs files strictly one-after-another, that one stuck
file blocks every file queued behind it — the entire rest of the suite never
runs, with no output and near-zero CPU, exactly matching what was observed.
This reproduces specifically when two sessions run tests concurrently, and
not when a single session runs alone, because a solo run has no second
process competing for the same socket.

**This exonerates `metaTemplateLibraryQA.test.js`.** An earlier theory
(from the other session) suspected a defect in that file's own real-cache
backup/restore logic (documented in CLAUDE.md's Known Gaps as a past, real,
separate incident). That file is unrelated to this hang — it never binds a
port at all. The other session was right to rule it out.

## The fix (not yet applied)

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

This removes the whole class of collision — same-invocation and
cross-session alike — rather than papering over one symptom of it. It needs
no new flag, no coordination between sessions, and no change to
`--test-concurrency=1` (which remains correct and necessary for the
same-invocation shared-database races it already fixes — see Conventions).

`server/test/embeddedSignupConnectRuntime.test.js` (added this session) has
the same anti-pattern on a different fixed port, `4001` — not implicated in
this specific hang, but the identical hazard, and should get the same fix
when this is done.

## Operational rule, effective immediately

**Nobody runs any Playwright-based test file while another session is also
running tests, until the port is de-collided (the fix above is applied).**
This is not a suggestion — a second session's test run can silently hang a
first session's run (or vice versa) for hours with zero visible error,
exactly as happened here. Check for a live `node --test`/`npm test` process
and a listener on port 4000 (`netstat -ano | findstr :4000` / `Get-NetTCPConnection
-LocalPort 4000`) before starting a Playwright-touching test run, until the
fix above ships.
