# Settings, pop-up forms and admin redesign

Status: **Approved 2026-11-21, in progress** (steps 1-2 done). Layout and visuals only: no API, DB, auth or
route changes (owner decision, 2026-11-21).

## Purpose
The owner says these areas are "very basic, all forms". This was confirmed by a real
audit (local server, local embedded Postgres, Playwright screenshots at 1440x900, 35
screens):

- **Every Settings section uses the same template:** a title, then ONE card, table
  or form, and a green button top-right. Most of the page stays empty.
  - Wallet shows only a balance, even though `GET /api/wallet` already returns
    the transaction history and the page never shows it.
  - Subscription is one card. The plan list (`GET /api/billing/plans`) is only
    shown behind a modal.
  - Tags shows 4 chips and nothing else. Contact counts per tag already exist
    in `GET /api/analytics/tags`.
  - Team, Attributes and Canned Responses are an empty table with one line of
    text.
- **All ~20 pop-ups are the same centered box** with stacked label and input. Most
  have no helper text, no preview and no context. For example, Invite Member asks
  for a Role without saying what each role can do.
- **Admin is tables only.**
  - Clients and Onboarding are walls of rows with no summary.
  - Team is one row on a blank page.
  - Admin Settings already uses status cards; it is the good example to extend.
  - The many `__test_suite__` rows are data pollution, not design. They are already
    tracked in memory (orphaned test clients) and are out of scope here.

## Patterns adopted (competitor/SaaS research, sources in research notes)
1. **Section header with context:** title, one-line purpose, and a short "what this
   is for" or help line (Shopify annotated settings).
2. **Summary first, detail second:** stat tiles or a hero card above the list
   (Gallabox wallet, Chargebee summary, Vercel usage).
3. **Read mode first, edit on demand** (AiSensy profile view + pen).
4. **Side drawer** instead of a centered modal for forms with 3 or more fields
   (Stripe FocusView). Escape, focus trap and an unsaved-change guard are reused
   from the existing modal a11y code.
5. **Inline add row** for 1–2 field lists: tags, canned-response title. Search
   that finds no match offers "Create" (Wati).
6. **Live preview beside the form** where output is visible to customers: canned
   response as a WhatsApp bubble, using `renderTemplateBubbleMarkup`'s styles.
7. **Teaching empty states:** icon, a one-line why, the primary action, and an
   example.
8. **Plan comparison cards inline** instead of behind "Change Plan".

## Per-screen design

### Client Settings
| Screen | Today | Proposed |
|---|---|---|
| WhatsApp | Connect bar + tabs + one line | Not connected: a 3-step "how connecting works" card with what you need (Facebook admin, number). Connected: profile in read mode beside a WhatsApp profile preview, Edit opens the existing fields |
| Team | Empty table | Roles explainer strip (Owner / Admin / Manager / Agent: what each can do) + member cards with avatar initials, role chip, status. Invite opens a drawer with role descriptions as radio cards |
| Wallet | Balance only | Balance hero (kept) + tiles (this month's credits added, spent, transaction count) + **recent transactions list** (existing data) + "what the wallet pays for" note. Recharge: preset amount chips (₹500/1000/2000/5000) + custom |
| Subscription | One card | Current plan card with the features included + **all plans side by side** from the existing plans API, current one marked. Change Plan acts on the chosen card |
| Billing | Table | Summary tiles (last paid, total invoices) above the existing table; teaching empty state |
| Developer / API | Already redesigned (`0a50062`) | Only the shared header/spacing tokens |
| Webhook | 3 numbered boxes in a card | Read mode when configured: endpoint, events as chips, secret masked with copy. Edit expands the existing form. "How deliveries work" side note |
| Tags | 4 chips | Tag rows: colour, name, contact count (existing analytics/tags), inline "add tag" row with a colour picker. No modal |
| Canned Responses | Table | Card list showing each reply as a WhatsApp bubble with its `/shortcut`. Add opens a drawer with a live bubble preview |
| Attributes | Table | Rows with a field-type icon. Add opens a drawer with type cards (Text/Number/Date/…) instead of a select, and the key auto-generated from the name (still editable) |

### Pop-ups
- **1–2 fields → inline:** Add Tag (inline row), Recharge (amount chips inside the
  wallet page). Each gets a fallback modal only where there is no page to inline
  into.
- **3 or more fields → right-side drawer with grouped sections and helper text:**
  Invite Member, Add Attribute, Add Canned Response, Add Contact, New Ticket,
  Create Payment Link, Create Rule.
- **Kept as centered modals** (correct pattern, already redesigned): confirm,
  error dialog, template type picker, campaign wizard, Create Template, flow editor.

### Admin
| Screen | Proposed |
|---|---|
| Clients | Summary tiles (total, active, pending setup, suspended, unpaid), status filter as chips, avatar initials column |
| Onboarding | Funnel strip: count per "stuck at" stage, clickable to filter. Rows keep the View button |
| Team | Member cards + role explainer; Invite opens a drawer |
| Client detail | Summary strip at top (status, plan, billing, WABA, last login) above the existing tabs |
| Other admin views | Shared header/tile components only where a summary is computable from data the page already loads |

## Architecture
- **New shared components in `design-system.css`:** `.section-header`, `.stat-tiles`,
  `.drawer` (+ `.drawer-footer`), `.inline-add-row`, `.option-cards` (radio cards),
  `.empty-teach`, `.plan-cards`. All use the existing tokens; no new colours.
- **`app.js` / `admin/app.js`:**
  - Render functions change markup only.
  - Submit handlers, validation, API calls and error handling (`reportError`)
    are reused unchanged.
  - The drawer reuses the existing modal open/close + focus-trap code (a
    `.modal-overlay.drawer-mode` variant), so Escape, focus trap and the
    "no click-outside close" rule stay identical.
- **No new endpoints.** Only data already fetched by these pages, or by an
  already-existing GET (`/api/analytics/tags`, `/api/billing/plans`).

## Impact map
| Touches | Risk |
|---|---|
| `index.html` settings sections + 7 modals | Element ids used by `app.js` handlers and by Playwright tests (`confirmPromptGroup23`, `modalInnerScrollGroup4`, `errorDialogUI`, `consentHardeningPhase2`, `teamMemberAuth`). Rule: **keep every existing id**; only wrappers and classes change |
| `app.js` render functions (tags, team, wallet, billing, canned, attributes, webhook, WhatsApp profile) | Regressions in list refresh after create/delete; role-gated buttons (Agent can't add) must stay gated |
| `admin/index.html` + `admin/app.js` (clients, onboarding, team, client detail) | `adminUiRedesign.test.js`, hash routing, typed-name delete, Payment/Service toggles |
| `design-system.css`, `index.css`, `admin/admin.css` | Mobile breakpoints 900/640; the drawer must become a bottom sheet / full-screen at 640px |
| Marketing, flow editor, API, DB | Not touched |

## Edge cases and failure modes
- **Empty states:** no tags, no members, no transactions, no invoices, no WhatsApp
  connected. Each gets a teaching empty state, not a blank table.
- **API failure on a secondary fetch:** for example, analytics/tags failing on the
  Tags page. The primary list still renders and the count column shows "—". It
  never blocks the page.
- **Long values:** long tag names, emails and webhook URLs truncate with a title
  tooltip; there is no horizontal overflow at 375px.
- **Permissions:** Agent sees lists read-only. Add/edit controls stay hidden and
  the server-side `requireRole` is unchanged.
- **Drawer with unsaved input + Escape:** ask before discarding. A submit in
  progress disables the footer buttons (existing loading-state behaviour, `4ca805a`).
- **Accessibility:**
  - Drawers keep `role="dialog"`, `aria-modal`, the focus trap and return focus
    to the trigger.
  - Option cards are real radio inputs.
  - Contrast stays on the V1 tokens.
- **Security:** the webhook secret is still never shown unless the existing flow
  shows it; copy-to-clipboard only. All user strings go through `esc()`.

## Acceptance criteria
1. Every one of the 10 client Settings sections has a section header with a purpose
   line and either a summary block or a teaching empty state; none is "title + one
   bare card".
2. Wallet shows the recent transactions from the existing API, and the recharge amount
   chips fill the amount.
3. Subscription shows all plans side by side with the current plan marked.
4. Tags can be added inline with no modal, and the per-tag contact count is shown.
5. Invite Member, Add Attribute, Add Canned Response, Add Contact, New Ticket, Create
   Payment Link and Create Rule open as right-side drawers on desktop and full-screen
   at 640px. Escape, the focus trap and return-focus all work.
6. Canned Response and the WhatsApp profile show a live WhatsApp-style preview.
7. Admin Clients and Onboarding show summary tiles; Onboarding shows a stage funnel
   that filters the list.
8. Every existing create/delete/update action still works end to end, with the same
   API calls.
9. No horizontal overflow at 375px; the existing Playwright UI suites still pass.
10. Zero diffs under `server/src/` (frontend-only change).

## Build order (each its own commit, tested, pushed)
1. Shared components (`drawer`, `stat-tiles`, `section-header`, `inline-add-row`,
   `option-cards`, `empty-teach`, `plan-cards`) and the drawer mode on the modal code.
2. Client Settings: Tags, Canned Responses, Attributes (inline add + drawers).
3. Client Settings: Wallet, Subscription, Billing.
4. Client Settings: Team, WhatsApp, Webhook.
5. Remaining pop-ups → drawers: Add Contact, New Ticket, Payment Link, Create Rule.
6. Admin: Clients, Onboarding, Team, Client Detail summary strip.

## Out of scope
- Auto-recharge (INR is restricted by RBI rules).
- Webhook delivery log, and canned-response usage counts or personal scope. These
  need new API fields; they are a later item if wanted.
- The `__test_suite__` data cleanup.
- The Automation Studio redesign proposal.
