# Instagram DMs

## Purpose
`view-instagram` is an honest "not connected" placeholder. Phase 1 code
(connect + basic inbox) already exists on branch
`feature/instagram-phase-1` (commit `a0a284a`, 2026-09-26), unmerged.

## Blockers (not engineering)
1. **Meta App Review** for `instagram_basic`, `instagram_manage_messages`,
   `pages_manage_metadata`, `pages_show_list` (and the business login
   config `META_IG_CONFIG_ID`). Until approved, only app-role test users can
   connect. Owner action in the Meta App Dashboard; lead time is days to
   weeks.
2. Branch migrations `081_instagram_accounts` / `082_...` sit below the
   applied range (master is at 093). Must be renumbered to the next free
   numbers when landed (SPEC decision 21), never run with
   `--no-check-order`.
3. The branch is ~2 months behind master (UI redesign, settings redesign,
   design tokens). Rebase conflicts expected in `index.html`/`app.js`/
   `metaWebhook.js`.

## Scope
Land Phase 1 as written (connect via Facebook Login for Business, list
conversations, read/reply inside Meta's 24h window), plus the known gap the
branch itself recorded: a 24h-window / `human_agent` tag gate on the send
route. Automation rules for comments/story mentions stay Phase 2.

## Impact map
- `metaWebhook.js` dispatch (branch adds an additive Instagram/Page branch;
  WhatsApp path must stay byte-identical - regression tests
  `metaWebhookDispatch`, `webhookForwarding`, echo routing).
- New tables `instagram_accounts`, `instagram_conversations`,
  `instagram_messages` + grants/RLS.
- `index.html` `view-instagram`, nav; `app.js`.

## Edge cases
- Token expiry (60-day long-lived Page token): surface "reconnect" state.
- Message outside 24h: send refused with a clear reason, not a raw Meta
  error.
- Page with no linked IG professional account: clear error on connect.

## Acceptance criteria
1. Branch rebased on master, migrations renumbered, full suite green.
2. A test-role IG account connects, a real DM appears in the inbox, a reply
   is delivered (needs owner's live test - no WhatsApp/IG send without
   explicit yes).
3. Reply outside 24h is refused with a readable message.
4. WhatsApp webhook regression tests unchanged and green.
