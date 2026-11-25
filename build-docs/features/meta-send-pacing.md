# Meta send pacing + 130429 retry

Owner request 2026-11-25 ("okay fix the issue").

## Purpose
- Wasi passed every send straight to Meta. LEADERS CONNECT's n8n fired 148
  requests in 4 seconds; Meta refused part of each burst with
  `(#130429) Rate limit hit` (20, 23, 24 and 25 Nov). Other providers queue
  and pace instead.

## Architecture
- `utils/metaSendThrottle.js`: per phone number, evenly spaced send slots
  (`META_SENDS_PER_SECOND`, default 15; Meta's throughput is higher for most
  numbers, and lower for Coexistence numbers, so 15 is the safe default).
  A burst waits for its slots instead of being refused.
- A 130429 is retried after 1s, 2s, 4s (each retry takes a new slot). 130429
  means Meta did not accept the message, so a retry cannot duplicate it. No
  other error is retried.
- If a number's queue is over 60s long, the send fails at once with
  "Too many messages are waiting" (only with about 900 queued).
- Wired around the Meta call in `messagingService.sendChatMessage` (after the
  pending message row and after the DB connection is released, so waiting
  holds no connection) and in the failed-message resend.
- Broadcasts pass `retryThrottled: false`: they are paced, but a 130429 is
  rescheduled by `broadcastRunner` (`markFailedAttempt`) instead of waiting
  inline, because the runner's tick is shared by every client.
- In-process: correct for the single app container. Several containers would
  each pace on their own.

## Impact map
- Every sender (Hub API/n8n/Zapier, inbox, flows, WooCommerce, forms, AI
  agent, broadcasts): sends from one number start at most 15 per second.
  An n8n burst of 148 now takes about 10s and the HTTP call waits; n8n's
  default timeout is 300s.
- Hub API response time rises during bursts (queue wait); single sends are unaffected.

## Acceptance criteria
1. Sends for one number are spaced 1/rate apart; numbers are independent; bursts queue.
2. A 130429 is retried and the send succeeds when Meta accepts the retry.
3. Retries stop after 3; other errors are never retried; `retry: false` never retries.
4. A queue longer than 60s refuses at once.
5. End to end: a 130429 on the Hub API is retried and answers 201.
6. End to end: 20 concurrent Hub API sends all succeed, spread over about 1.3s.
