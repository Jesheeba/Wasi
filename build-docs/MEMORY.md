# Project memory

## 2026-11-21 - open issues found during the settings redesign
- Admin roles (support/billing/super_admin) are stored but never checked by
  any route: every admin has full access. Surfaced in the UI, not fixed
  (permissions change, out of a layout pass). Needs an owner decision.
- errorDialogUI.test.js test 2 is stale (predates the template type
  picker, 88bc697); fails on the pre-redesign tree too.
- WhatsApp Message Link builder is not browser-tested (needs a connected
  WABA locally).

## 2026-11-21 - settings/forms/admin redesign approved
Owner approved the plan ("build end to end"). Layout + visuals only, zero
server diffs. Drawers are `.modal-overlay.as-drawer` (same markup and ids)
rather than a second dialog system, so the global focus trap/Escape code is
reused. Wallet shows top-ups only: nothing in the app records wallet
spending, so no "spent" figure is shown (would be invented). Found while
building: Add Attribute had always failed (capitalised type vs lowercase
enum) - fixed client-side.

## 2026-11-16 - client-suspension-paywall scope
Decision: the "pay to continue" hard block gates on `clients.status ===
'suspended'` only, NOT `pending_setup`. Reason: `pending_setup` is a
separate, already-known bug - 5 real, currently-working clients (Brainlit,
RD interblocks, Know Mind, both Sirah accounts) are wrongly stuck there
despite sending fine, because nothing in this app sets
`payment_confirmed`/`active` for a client not onboarded through a Razorpay
subscription. Gating the paywall on `pending_setup` too would have shown
those 5 a false payment wall. Flagged to the user before implementing;
proceeded with `suspended`-only per the recommended option, no objection
raised. If `pending_setup` is ever fixed (see
`project_pending_setup_status_bug` in the global memory file), this scope
decision should be revisited.

## 2026-11-14 - GV Mart root cause (context for the above)
GV Mart's actual send failures that day were Meta's own error 131042
("Business eligibility payment issue") - a Meta-side WABA billing flag,
unrelated to this app. Separately, GV Mart's `clients.status` was found
stuck at `pending_setup` despite a connected WABA (the bug above). The user
manually flipped it to `active` in admin; investigated whether that itself
had any code-level effect on sending (it doesn't - `clients.status` gated
nothing before this feature) and whether the timing was coincidental with
Meta's own block clearing - not conclusively resolved, not re-investigated
further since the account was confirmed working.
