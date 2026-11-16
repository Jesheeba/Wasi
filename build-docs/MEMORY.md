# Project memory

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
