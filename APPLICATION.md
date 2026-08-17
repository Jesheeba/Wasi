# Wasi WhatsApp CRM — Clone (`wasi-crm-clone`)

> **This file describes the original UI-clone-only state of the project and is now
> partially outdated** — a real backend has since been built (Postgres via Supabase,
> real WhatsApp Cloud API send/receive, Razorpay billing, admin panel). It's kept for
> the front-end architecture details below, which are still accurate. For current,
> accurate documentation see `server/README.md` (API surface, background workers),
> `DEPLOY.md` (production deploy), and `GO_LIVE_CHECKLIST.md` (what's left on the
> Meta/Razorpay account side before real clients can use this).

A **[originally]** static, front-end-only clone of the **Wasi** "Smart Conversations" WhatsApp CRM (`app.kwic.in`). It reproduces the UI/UX and in-browser interactivity of the original product using plain HTML/CSS/JS — the front-end architecture (view-switching, DOM rendering) described below is unchanged, but `app.js` now talks to a real backend instead of an in-memory mock store (see `server/README.md`).

## 1. Overview

| | |
|---|---|
| **Name** | wasi-crm-clone |
| **Version** | 1.0.0 |
| **Description** | Wasi WhatsApp CRM & Smart Conversations Application Clone |
| **License** | MIT |
| **Author** | Antigravity |
| **Type** | Static single-page application (SPA), no build step |
| **Entry point** | [index.html](index.html) |

### Purpose

This project is a pixel-oriented **clone/reference implementation** of the Wasi CRM product, built by scraping the live application (`app.kwic.in`) with Playwright and reconstructing its screens as static markup. It's useful for UI prototyping, demos, and design reference rather than as a production CRM.

## 2. Tech Stack

- **HTML5** — single [index.html](index.html) (~77 KB) containing the auth screen, app shell, every view, and every modal
- **CSS3** — [index.css](index.css) (~22 KB), hand-written design system (no framework like Tailwind/Bootstrap)
- **Vanilla JavaScript (ES6+)** — [app.js](app.js) (~28 KB), no framework (no React/Vue/Angular), DOM APIs only
- **[Lucide Icons](https://lucide.dev/)** — loaded via CDN (`https://unpkg.com/lucide@latest`), rendered with `lucide.createIcons()`
- **[Playwright](https://playwright.dev/)** (`^1.62.1`) — dev-only dependency used solely by the scraping script, not shipped to the app itself
- **[`serve`](https://www.npmjs.com/package/serve)** (via `npx`) — static file server for local development

No bundler, no transpiler, no package beyond `playwright` in `package.json`.

## 3. Project Structure

```
clone_crm_sirah/
├── index.html          # Full markup: auth view, app shell, all views, all modals
├── index.css           # Design tokens + component styles
├── app.js              # All client-side logic, state, and event wiring
├── scrape_kwic.js       # Playwright script that scraped app.kwic.in for reference
├── package.json         # npm metadata + "start" script
├── package-lock.json
├── serve.log             # Log output from the last `npm start` / serve run
├── marketing/            # Public marketing site + client onboarding wizard (see below)
├── server/               # Express + Postgres backend (auth, onboarding, billing APIs)
└── node_modules/
```

There is no `src/`, no build output directory for the app itself. The `server/` directory (see `server/README.md`) is a separate real backend; `index.html`/`index.css`/`app.js` remain a self-contained front end with no build step.

### 3.1 `marketing/` — landing page & onboarding wizard

A second, independent static site living alongside the CRM app, targeting prospective customers rather than logged-in users: `marketing/index.html` (the public landing page — hero, feature grid, pricing, WhatsApp API explainer, FAQ) and `marketing/signup.html` (a 4-step client onboarding wizard — account creation, plan/payment, WhatsApp Embedded Signup, done) plus their shared `marketing/marketing.css` and per-page `marketing/marketing.js` / `marketing/signup.js`. It deliberately duplicates the design tokens from `index.css` rather than linking it, and talks directly to the `server/` API (`/api/auth`, `/api/billing`, `/api/onboarding`) via `fetch` — no bundler, same plain HTML/CSS/vanilla-JS conventions as the rest of the repo.

## 4. Running the App

```bash
npm start
```

This runs `npx -y serve -l 3000 .`, serving the project root as static files at **http://localhost:3000**. Simply opening `index.html` directly in a browser also works since there are no server-side dependencies, though `serve` avoids `file://` CORS/path quirks.

## 5. Application Architecture

### 5.1 Single-file SPA, view-switching via CSS classes

The entire app lives in one HTML document. "Navigation" doesn't change the URL or load new pages — it toggles `.active` classes:

- Top-level views are `<div id="view-{name}" class="view-container">` elements; [app.js](app.js) `switchView()` adds/removes `.active` to show exactly one at a time.
- Left sidebar links (`.nav-item[data-view]`) drive `switchView()`.
- Some views have their own **secondary/nested navigation** (e.g., Reports, Settings) using `.sec-nav-item[data-rep-view]` / `.sec-nav-item[data-sec-view]`, toggling nested `.rep-content-view` / `.sec-content-view` panels independently of the main router.
- Modals are `<div id="modal-*" class="modal-overlay">` toggled with an `.open` class; closed via any `[data-close-modal]` button.

### 5.2 State management

All application data lives in a single in-memory `state` object created at `DOMContentLoaded` inside [app.js](app.js) (no persistence — a page refresh resets everything to the seed data):

```js
state = {
  user, currentView, activeChatId,
  chats: [...],            // WhatsApp inbox conversations
  contacts: [...],         // CRM contact records
  broadcasts: [...],       // Campaign/broadcast history
  automationRules: [...],  // Keyword-trigger automation rules
  tags: [...],             // Contact tag definitions (name/bg/color)
  templates: [...]         // WhatsApp message templates
}
```

Views are rendered imperatively: functions like `renderChatList()`, `renderContacts()`, `renderBroadcasts()`, `renderAutomation()`, `renderTemplates()`, `renderTagsManager()` rebuild `innerHTML` from the current `state` whenever the relevant view becomes active or data changes. There is no virtual DOM / diffing — full re-render of the affected container each time.

### 5.3 No backend / persistence

- No API calls, no `fetch`/`XMLHttpRequest` to any backend.
- No `localStorage`/`sessionStorage`/cookies.
- Login (`#login-form`) accepts **any** email/password — it just sets `state.user` and swaps `#auth-view` for `#app-shell`. Logout is a `confirm()` dialog that reverses this.
- All "create" actions (new contact, campaign, template, tag, team member, payment link, flow, automation rule, wallet recharge) push into the in-memory arrays and re-render — nothing is saved beyond the session/page lifetime.

## 6. Feature Areas / Views

Each corresponds to a sidebar nav item (`data-view`) and a `#view-*` container in [index.html](index.html):

| View (`data-view`) | Purpose |
|---|---|
| `chat` | WhatsApp-style inbox: chat list with tag filters, active conversation thread, message composer, attachment picker, contact details drawer (tags/attributes) |
| `contacts` | CRM contact table (name, phone, tag, status, created date) with live search filter and "Add Contact" modal |
| `campaigns` | Broadcast/campaign history table (title, tag, status, delivered, read rate, date) + "Create Campaign" modal |
| `template` | WhatsApp message template gallery (name, category, approval badge, body with `{{n}}` placeholders) + "Create Template" modal |
| `automation` | Keyword-trigger automation rules (trigger → action) as cards + "Create Rule" modal |
| `ecommerce` | Catalog & cart-recovery screen (static content, catalog sync action) |
| `whatsapp-flows` | WhatsApp Flows list (submissions/completion rate) + "Create Flow" modal |
| `instagram` | Instagram DM automation settings |
| `ctwa` | Click-to-WhatsApp Ads configuration |
| `integrations` | Third-party integrations |
| `payments` | UPI/payment link table + "Create Payment Link" modal |
| `analytics` | Multi-panel dashboard: tag performance, campaign analytics, flow submissions, API/webhook performance, live-chat widget analytics, operator/agent performance |
| `settings` | Nested settings area (see below) |

### 6.1 Settings sub-views (`data-sec-view`, inside `view-settings`)

`whatsapp` (channel settings, inner tabs), `live-chat` (widget customizer), `instagram`, `team` (invite member modal + table), `wallet` (recharge modal, balance display), `subscription`, `developer` (API key copy-to-clipboard), `tags` (Tag Manager + "Add Tag" modal), `attributes` (Custom Contact Attributes + "Add Attribute" modal), `webhook` (callback config, "Save Webhook" action), `billing` (invoices).

### 6.2 Reports sub-views (`data-rep-view`, inside `view-analytics`)

`message`, `tags`, `campaign`, `flow`, `api`, `live-chat`, `operator-stats`.

## 7. Interaction Inventory (from `app.js`)

- **Auth**: login form submit, password visibility toggle, logout confirmation
- **Routing**: main sidebar nav, settings sub-nav, reports sub-nav, WhatsApp channel inner tabs
- **Chat**: open conversation, send message (Enter key or button), attach file (mocked — just echoes filename into thread), tag-based inbox filter dropdown
- **Modals** (10 total, all with open/submit/close wiring): Add Contact, Create Campaign, Create Template, Add Tag, Invite Member, Add Attribute, Create Payment Link, Create Flow, Recharge Wallet, Create Automation Rule
- **Misc actions with toast feedback** (`showToast()`): sync catalog, refresh reports, copy API key (via `navigator.clipboard`), save webhook, upgrade subscription prompt
- **Contacts search**: client-side substring filter over the rendered table rows

All list/table mutations are pure client-side array pushes followed by a targeted re-render — none of it survives a reload.

## 8. Design System (from `index.css`)

CSS custom properties define the visual language:

```css
--color-primary: #4AC959;      /* Wasi brand green */
--color-dark: #143518;
--color-heading: #304742;
--bg-app: #F6F9F6;
--bg-card: #FFFFFF;
--text-main: #1F2937;
--text-muted: #6B7280;
--border-light: #E5E7EB;
--border-tertiary: #E2E8F0;
--shadow-sm / --shadow-card / --shadow-login
--sidebar-width: 250px;
--sidebar-collapsed-width: 72px;
--header-height: 64px;
```

Typography: `'Poppins', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif`. Layout is a fixed dark-green sidebar + top header + scrollable content area, matching the original Wasi product's forest-green branding.

## 9. Reference Scraper (`scrape_kwic.js`)

A standalone Node/Playwright script (not run by the app itself) used to capture the real Wasi product for reference during cloning:

1. Launches headless Chromium, logs into `https://app.kwic.in/login` using `KWIC_USERNAME`/`KWIC_PASSWORD` env vars.
2. Visits ~28 authenticated routes (chat, contacts, campaigns, templates, automation, ecommerce, flows, instagram, CTWA, integrations, payments, analytics, all reports sub-pages, all settings sub-pages).
3. Saves a full-page screenshot (`.png`) and the rendered HTML (`.html`) for each route into `scraped_pages/`.

This script requires live credentials to the real Wasi service and is a dev/research tool — it is **not** part of the deployed clone and has no runtime dependency on it.

## 10. Known Limitations (updated)

- **Real backend, real WhatsApp Cloud API messaging, real auth, real persistence** — the
  bullets that used to be here (no backend, mock login, no storage) are no longer true.
  See `server/README.md` for the full picture.
- Ecommerce catalog, WhatsApp Flows, Instagram DM automation, and Click-to-WhatsApp Ads
  config remain static/decorative — each is a separate Meta product integration,
  deliberately out of scope for the backend build (see `GO_LIVE_CHECKLIST.md` §4).
  Same for the Flow/API/Live-Chat/Operator-stats report sub-views (no underlying
  feature yet to report real numbers on) — Message, Tags, and Campaign reports are real.
- No genuine AI features (auto-reply suggestions, campaign copy generation, etc.) —
  deliberately deferred to be scoped later; the keyword-trigger automation engine
  covers Kwick's actual (non-AI) automation feature set in the meantime.
- Inline styles are used extensively throughout `index.html` rather than CSS classes, which is typical of scraped/reconstructed markup.
