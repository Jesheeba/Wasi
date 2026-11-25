# Hub API: conversations paging + optional client_id

Teammate report 2026-11-25 (three Hub API gaps).

## Purpose
- `GET /api/v1/conversations` only read `limit` (max 100). `since`, `after`,
  `updated_after`, `page` and `offset` were dropped without an error, so
  nothing past the newest 100 conversations could be read.
- `POST /api/v1/messages` required `client_id` in the body, although the
  API key already identifies the client.
- Third report (template params not checked before Meta) was already fixed
  in `20e5bbb` (`params_mismatch`), not yet deployed when tested.

## Architecture
- `routes/apiV1Conversations.js` list schema: `limit` (1-100, default 20),
  `offset` (>= 0), `updated_after` (any date `z.coerce.date` accepts; `since`
  is an alias) -> `chatsRepo.list`'s existing `since` filter
  (`last_message_at > t`). `.strict()`: any other param is 400 `validation_failed`.
- `chatsRepo.list` orders `last_message_at desc, id desc` so offset pages
  never repeat or skip a row on a tie.
- `apiMessageSendSchema.client_id` optional; `apiV1Messages.js` still
  refuses a sent value that doesn't match the key (403 `client_id_mismatch`).

## Impact map
- `chatsRepo.list` is also the CRM inbox list: only tie order changes.
- MCP `list_conversations` and the n8n node send only `limit`: unaffected.
  MCP still sends `client_id`: still accepted.
- An external caller that sends an unknown query param now gets a 400
  instead of silently wrong results. Intended.
- Offset paging over a list ordered by activity can shift if a chat gets a
  message mid-paging; a poller should use `updated_after`.

## Acceptance criteria
1. `offset` pages through every conversation once, newest first.
2. `updated_after` / `since` return only conversations active after that time.
3. Unknown or malformed params (`page`, `after`, bad date, negative offset) -> 400.
4. A send without `client_id` passes validation; a wrong one -> 403.
