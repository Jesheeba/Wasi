# Automation rule: view, edit, enable/disable

## Purpose
The Rules table on Automation was read-only. Once you created a rule, you
couldn't open it, read the full reply (cut off with "…"), edit it, or turn
it off. `PATCH /api/automation-rules/:id` existed (title/trigger only) but no
screen called it.

## Architecture
- **Table** (`app.js` `renderAutomation`): rows are clickable and keyboard-
  focusable (Enter/Space). The rule name underlines on hover. They open the
  drawer. No separate View column: at 1440px a sixth column was clipped off
  the card. The Status column is an Enabled/Disabled switch (`.wasi-toggle`,
  moved from `admin.css` to `design-system.css`). It PATCHes `{status}`,
  is locked while the call is in flight, and reverts on failure. Clicking it
  never opens the drawer.
- **Drawer**: reuses `#modal-create-rule`. `openRuleDrawer(rule|null)`.
  `editingRuleId` decides POST vs PATCH. It adds a live WhatsApp bubble preview
  of the reply (reply field is now a textarea), a "Starts flow: X" row with an Open flow button
  (`openFlowEditor`), and an Enabled switch.
- **Server**: `automationRuleUpdateSchema` accepts `title, trigger, action,
  flow_id, status ('Enabled'|'Disabled')`, but not both action and flow_id.
  `automationRulesRepo.update` clears the other column when one is set, so
  the DB `automation_rules_action_xor_flow` constraint always holds. The PATCH
  route checks that `flow_id` belongs to the client, because an FK check
  bypasses RLS.

## Impact map
- `automationEngine.js`: runs only `status === 'Enabled'`. Disabled rules
  are skipped. No code change.
- Flows table "Trigger" column reads rules by `flow_id`. Switching a rule's
  kind updates it on the next render.
- Admin Service/Payment toggles: same CSS, now loaded from design-system.css.
- Old status badge compared to `'active'`, so every real (`'Enabled'`) rule
  showed a grey badge. The switch replaces it.

## Edge cases
- PATCH failure: the switch reverts and `reportError` shows why.
- Create with the switch off: POST (always Enabled), then PATCH Disabled.
- Unknown/foreign flow_id: 400. Both action+flow_id: 400 (Zod).
- Row clicked after the rule vanished from state: no-op.
- Delete: added in the audit below (item I).

## Audit (2026-11-23)
Checked the engine, API and UI end to end. Production had 5 rules: 1 with
trigger `*`, 1 pointing at an archived flow. Decisions B and H by the owner.
- **A (bug)** Deleting a flow that a rule started failed with a check-
  constraint error: `flow_id` is ON DELETE SET NULL but the XOR constraint
  forbids a rule with neither. Fix: `automationFlowsRepo.remove` deletes those
  rules first in the same transaction. The confirm dialog names them.
- **B (bug)** `*` was matched literally, so a "reply to anything" rule never
  fired. Now `*` is a catch-all: it runs only when no keyword rule matched,
  never while the contact is inside an active flow, and at most once per chat
  per 24h (`chats.auto_reply_at`, migration 094, claimed with one conditional
  UPDATE and released if nothing was sent). Shown as "* Any message".
- **H** Keywords matched inside words ("hi" fired on "this"). Now whole word
  or phrase, case-insensitive, Unicode-aware (Tamil vowel signs count as part
  of the word), any whitespace inside a phrase.
- **D** A rule whose flow is draft/archived/missing does nothing, silently.
  Now a warning badge in the table, a warning in the drawer, and flow status
  in the flow dropdown.
- **G** Two enabled rules with the same keyword: only the newest ever
  replies. Now a live warning in the drawer (not blocking).
- **I** No way to delete a rule. `DELETE /api/automation-rules/:id`
  (Admin/Manager) and a Delete button in the drawer with a confirm.
- **F** Whitespace-only trigger/title/reply passed create; invalid id on
  PATCH was a Postgres 500. Both now 400.
- Deploy order: migration 094 before the code (see its header).

## Acceptance criteria
1. Clicking a row opens the drawer prefilled, with the full reply in
   a WhatsApp bubble.
2. Saving edits PATCHes and the table shows the new values.
3. Table switch disables/enables a rule. Status persists after reload.
4. Disabled rule is not matched by `automationEngine`.
5. Switching a text rule to a flow clears `action` (XOR holds).
6. A foreign `flow_id` is rejected with 400.
