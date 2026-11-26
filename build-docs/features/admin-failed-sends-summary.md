# Admin: failed sends summary

## Purpose
Answering "why did Leaders Connect's campaign fail?" (2026-11-26) took raw SQL.
Their failures were spread over a Wasi broadcast (12 Nov, Meta 131042 payment
issue) and an n8n Hub API send (25 Nov, 584 x 132000 wrong parameter count,
plus rate limits). Admin showed only the last 20 API sends, ungrouped.

## Architecture
- `chatsRepo.failedSendsSummary(db, clientId, days=7)`: failed outbound
  `messages` for one client, grouped by template (from the
  `[template: <name>]` body), source, and `meta_error_code`. Source is
  `Campaign` (a `broadcast_recipients` row points at the message), the API key's
  `app_name`, or `Inbox / flow`. Returns attempts, distinct contacts, first/last.
- `GET /api/admin/clients/:id` adds `failedSends`, each with `explanation` from
  `describeMessageFailure` (the one plain-language map; 130472 and 131042 added,
  130429 no longer claims "retried automatically").
- Admin Client Detail > Activity: "Failed sends (last 7 days)" table, first card.

## Impact map
- `admin.js` client detail route: one more parallel query, read-only, privileged
  pool, scoped by client id. Same route gating as before.
- `metaMessageErrorMessages.js`: also used by the client's broadcast detail
  view; wording change only.
- No migration, no webhook payload change.

## Edge cases
- No failures: empty state. Non-template sends: "(not a template)".
- Pre-send failures without a Meta code: "No Meta code" plus raw reason.
- Attempts > contacts: the sender retried the same people (shown, not inferred).
- Capped at 50 groups.

## Acceptance criteria
1. Failures group by template + source + error code with correct attempts and contacts.
2. Source distinguishes Campaign, API app name, Inbox / flow.
3. Known codes get the plain-language explanation; unknown keep raw text.
4. Failures older than 7 days, other clients' failures, and successful sends are excluded.
5. The admin Activity tab renders the table, or the empty state.
