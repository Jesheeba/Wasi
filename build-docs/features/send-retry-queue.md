# Send retry queue (no message lost to a network or temporary Meta error)

Owner request 2026-11-25: "make sure no numbers has been failed because of the
network connection... any message vanished must be queued and retried".
Decisions (owner, same day): retry all network errors, accepting a rare
duplicate when Meta received the message but its answer was lost (the same
rule broadcasts already use); the Hub API answers 202 `queued` when a send is
queued.

## Purpose
- 5 sends in 4 days (Fortune's CRM, TNPSC's OTP) failed with "fetch failed":
  our server could not reach Meta. They were saved as `failed` and never
  retried. Broadcasts already reschedule such errors; every other sender
  (Hub API/n8n, inbox, flows, WooCommerce, forms, AI agent) gave up at once.

## Architecture
- `utils/metaSendThrottle.js` `isTransientMetaError(err)`: no HTTP answer
  ("fetch failed", connection reset/refused, DNS, our 20s timeout), HTTP 5xx,
  or Meta codes 1, 2, 4, 130429, 131000, 131016, 131056, 133004. Shared with
  `broadcastRunner.isTransientSendError` (one rule, not two).
- Inline: the pacer retries a transient error after 1s, 2s, 4s (not timeouts,
  which already took 20s; they go straight to the queue).
- Queue: if it still fails, `sendChatMessage` keeps the message `pending`,
  stores the exact Meta call in `messages.send_request` (function + arguments,
  never the access token) and `next_retry_at`, and returns it with
  `queued: true`. Hub API answers **202** with `status: "pending"`,
  `queued: true`.
- `services/messageRetryRunner.js` (forwardRunner pattern, 15s tick): claims
  due rows (`FOR UPDATE SKIP LOCKED`, 5-minute lease), reloads the WABA and
  token, replays the call through the pacer. Success: `sent` + Meta id +
  usage count. Transient failure: retries at 1, 2, 5, 10, 20, 30 min (about
  70 min in all). Permanent error, no connected number, or out of retries:
  `failed` with the reason.
- Network errors now keep their cause: "fetch failed (ECONNRESET)".
- Broadcasts keep their own rescheduling (`retryTransient: false`).
- Migration 113: `messages.retry_count`, `next_retry_at`, `send_request`.
  Excluded from webhook forwarding (`metaWebhook.js` convention). Table-level
  grant already covers new columns.

## Impact map
- `messagingService.sendChatMessage`: the Meta call becomes one serializable
  `{fn, args}`; callers get a `pending` message instead of an exception for
  transient failures. Callers that treat a returned message as sent (flows,
  AI agent metering, WooCommerce) count a queued one as sent; if it finally
  fails after ~70 min it stays visible as `failed`.
- Hub API: 202 instead of 502 for transient failures. A caller requiring
  exactly 201 needs a change; any-2xx callers are unaffected.
- Inbox: the message shows as pending until the retry sends it.
- 24h window: a text replayed after the window closed fails at Meta (131047,
  permanent) and is marked failed, as it should.
- Process restart: queued rows are in the DB, the runner resumes them.

## Edge cases
- Duplicate: an ambiguous error (Meta got it, answer lost) can deliver twice.
  Accepted by the owner.
- Runner crash mid-send: lease expires after 5 minutes, row is retried.
- `send_request.fn` is checked against an allow-list before calling metaClient.

## Acceptance criteria
1. Transient classification: network, timeout, 5xx and the listed Meta codes
   yes; 131026, 132000, 131047 etc. no.
2. A network blip that clears within the inline retries sends normally (201).
3. A send that keeps failing on the network is queued: Hub API 202,
   `queued: true`, row `pending` with `send_request`, no token stored.
4. The runner sends a due queued row: `sent`, Meta id stored, queue fields cleared.
5. A permanent error on retry, or running out of retries, marks it `failed`.
6. A permanent error on the first send still answers 502 `send_failed` (not queued).
7. Broadcasts still reschedule on their own (no inline queue).
