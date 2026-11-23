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
- Delete is out of scope (no DELETE route). Disable covers "stop it".

## Acceptance criteria
1. Clicking a row opens the drawer prefilled, with the full reply in
   a WhatsApp bubble.
2. Saving edits PATCHes and the table shows the new values.
3. Table switch disables/enables a rule. Status persists after reload.
4. Disabled rule is not matched by `automationEngine`.
5. Switching a text rule to a flow clears `action` (XOR holds).
6. A foreign `flow_id` is rejected with 400.
