# Daily sending limit visibility

## Purpose
Meta caps unique people a number can message first per 24h (a client
on 250). Clients saw only a top banner at the lowest tier and a line inside the
New Campaign wizard; API/n8n senders saw nothing and hit the cap blind.

## Architecture
- `services/messagingLimitService.getMessagingLimitStatus` (moved from
  `routes/broadcasts.js`): tier, cap, used, remaining, quality, connected.
- "Used" now follows Meta's rule more closely: distinct chats with a
  non-failed outbound in 24h that was NOT sent inside an open customer window
  (no inbound from them in the 24h before). Before, every outbound counted.
- Client: card on Campaigns and Settings > WhatsApp (`renderMessagingLimitCard`,
  from `/api/broadcasts/tier-status`, Admin/Manager; hidden on error/Agent),
  with "How to raise the limit".
- API: `GET /api/v1/account` -> `messaging_limit`.

## Impact map
`routes/broadcasts.js` (tier-status + launch warning now use the service),
`routes/apiV1Account.js`, `app.js`, `index.html`, `index.css`. Query uses the
existing `messages(chat_id, sent_at)` index.

## Edge cases
Unknown tier -> no numbers claimed; unlimited -> "No daily limit"; under 10%
left -> warning colour; not connected -> hidden. Still an estimate: sends made
outside Wasi are invisible to it.

## Acceptance criteria
AC9-AC12 in the same test file; visual check on Campaigns + Settings.
