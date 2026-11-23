# Click-to-WhatsApp Ads page

## Purpose
`view-ctwa` exists in the DOM with fake numbers (1,420 clicks, 385 leads,
₹14.20 CPL) and no nav link. The data behind a real version is already
captured: `messages.referral` (migration 065) stores Meta's CTWA `referral`
object on every inbound message that came from an ad, and
`GET /api/analytics/ctwa` already aggregates it. Only the screen is missing.

## Scope
- Show what we actually have: leads (distinct chats) and messages per ad
  (`source_id` + `headline`), first-seen / last-seen, and a list of the
  chats each ad produced (click through to the chat).
- **Not shown: ad clicks, spend, cost per lead.** Those live in Meta's
  Marketing API (`ads_read`), which this app has no permission or token for.
  Showing them would mean inventing them. The page says so in one line.
- Date range: 7 / 30 / 90 days / all time (`?since`, already supported).

## Architecture
- Server: extend `GET /api/analytics/ctwa` with `leadCount`
  (`count(distinct chat_id)`), `firstAt`, `lastAt`, `sourceUrl`,
  `sourceType` per group. New `GET /api/analytics/ctwa/:sourceId/chats`
  (chat id, contact name/phone, first ad message time). Both stay behind the
  router's existing Admin/Manager gate.
- Client: replace `view-ctwa` markup with summary tiles + table + empty
  state; add nav item under Engage; `renderCtwaView()` in `app.js`.
- No migration.

## Impact map
- `routes/analytics.js` (`/ctwa` response gains fields; additive, no
  existing caller in `app.js` today, so nothing to break).
- `index.html` nav + `view-ctwa`; `app.js` `VALID_VIEWS` (derived from nav,
  so it picks the view up automatically) and `applyRoleGating` (hide for
  Agent, matching the server gate).
- Reads `messages`/`chats`/`contacts` via `req.db` (tenant-scoped, table
  grants already cover them).

## Edge cases
- No ad traffic ever: empty state explaining how CTWA works and that leads
  appear automatically, no fake rows.
- `headline` or `source_id` null in Meta's payload: group under
  "Unnamed ad", never drop the row.
- Agent role: nav hidden and server returns 403 (existing gate).
- Contact deleted: chat row still listed with phone only.

## Acceptance criteria
1. Nav item "Click-to-WhatsApp Ads" opens the view; `#ctwa` deep-links.
2. With seeded referral messages for 2 ads, the table shows 2 rows with
   correct lead and message counts; the range filter changes them.
3. Clicking an ad lists its chats; clicking a chat opens it in Chat.
4. No ad clicks, spend or CPL figure appears anywhere.
5. Agent role cannot see the nav item and gets 403 from both endpoints.
6. Zero-data client sees the empty state.
