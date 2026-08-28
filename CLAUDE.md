# Wasi — Project Context (auto-loaded by Claude Code)

## What this is

Wasi is a WhatsApp Business CRM: a client-facing app (chat inbox, contacts, campaigns, templates, automation), an internal admin panel for onboarding/operating client accounts, and a public marketing/signup site — all backed by a real Express + Postgres backend on Meta's WhatsApp Cloud API. A Hub API (`/api/v1/*`) and an MCP server let third-party apps and AI assistants send messages and read data through a client's own account.

## Architecture summary

Plain CommonJS Node, no build step, no TypeScript. Three static-HTML/vanilla-JS surfaces sharing one Express backend (`server/`):
- **Root CRM app** (`index.html`/`index.css`/`app.js`) — the logged-in client app.
- **`admin/`** — the internal ops console (separate login, `requireAdminAuth`).
- **`marketing/`** — public landing page + signup wizard, no auth.
- **`mcp-server/`** — standalone npm package wrapping the Hub API as MCP tools for AI clients (local/stdio transport only).

See `server/README.md` for the API surface and background workers, `DEPLOY.md` for production deploy, `crm-integration-guide.md` for the Hub API's own docs (distinct audience from this file — see §4.2 note below), `wasi-master-plan.md` for the long-range feature roadmap this table tracks against.

## Feature inventory (update this table every time a feature ships)

| Feature | Status | Where | Docs |
|---|---|---|---|
| WhatsApp send (text/template/button/list) | Live | Hub API v1, `server/src/routes/apiV1Messages.js` | `crm-integration-guide.md` |
| Webhook forwarding to client CRMs | Live | `server/src/services/forwardRunner.js` | `crm-integration-guide.md` §3 |
| MCP server | Live (local/stdio only) | `mcp-server/` | `mcp-server/README.md` |
| Client self-serve API key mgmt (revoke/delete) | Live | `server/src/routes/apiKeys.js`, root app Settings > Developer | (this file) |
| Admin: API key soft-delete, webhook secret masking | Live + verified | `server/src/routes/admin.js` | — |
| Admin: clickable KPI cards, hash routing | Live | `admin/app.js` | — |
| Admin: Statistics view (Chart.js) | Live | `admin/index.html`/`app.js`, `GET /api/admin/stats` | — |
| Admin: expanded Client Creation form | Live | `admin/app.js` `handleCreateClientSubmit` | — |
| Admin: API Integration Guide + Postman collection | Live | `admin/index.html` API Guide view, `postman/` | `admin/index.html` API Guide view itself |
| Mobile-responsive layout (all 3 surfaces) | Live + verified (2026-08-28) | `breakpoints.css`, `admin/admin.css`, `index.css`, `marketing/marketing.css` | (this file) |
| Template Library | Not started | — | `wasi-master-plan.md` §2 |
| Integrations Marketplace | Not started | — | `wasi-master-plan.md` §3 |
| Broadcast/Campaign Engine | Not started (root app's Campaigns view is a static mock) | — | `wasi-master-plan.md` §8.3 |
| Chatbot/Automation Flow Builder | Has a spike, not shipped as the primary flow-building surface | `flow-editor/` (React Flow, separate from root app's in-CRM bot-flow-editor modal) | `wasi-master-plan.md` §8.4 |
| Shared Team Inbox | Not started | — | `wasi-master-plan.md` §8.5 |

## Known gaps / deliberately deferred

- **MCP remote/OAuth transport** — deferred, local/stdio only for now (see `mcp-server/README.md` Scope section).
- **`npm publish` for `@wasi/mcp-server`** — deliberately not published yet; the package is fully installable from a repo checkout, and the `npx @wasi/mcp-server` command referenced in docs/UI will start working the moment it is.
- **Root CRM dead views/sub-tabs** — `view-ecommerce`, `view-whatsapp-flows`, `view-ctwa` (main nav), and Analytics' `rep-view-flow`/`rep-view-api`/`rep-view-live-chat`/`rep-view-operator-stats` sub-tabs exist in the DOM with full markup but have no nav item pointing to them (intentionally hidden, commit `946a8ec`). Confirmed dead, not audited or fixed as part of the mobile-responsive pass.
- **`api_keys.key_hash` exposure** — was leaking in 2 admin routes (`POST /api-keys`, `POST /api-keys/:id/revoke`), fixed 2026-08-28. Low severity (unsalted SHA-256 of a 24-byte random key, not practically reversible) but worth knowing the history if it resurfaces via a future `returning *` route.
- **Root CRM modals beyond Chat/Contacts/Settings/Analytics** — `list_reply` inbound webhook handling was built from Meta's spec and is unverified against a real capture as of the interactive-messages work.

## Conventions this codebase follows

- Plain CommonJS, no TypeScript, no bundler on any of the three front-end surfaces.
- Backend tests: `node --test` (built-in runner), no jest/mocha. Outbound Meta calls are faked by stubbing `global.fetch` for `graph.facebook.com` URLs only — never the app's own local-server fetches.
- **Local `DATABASE_URL` is the same shared Supabase instance as production** — there is no separate dev database. `server/src/utils/dbSafety.js` refuses any DB-touching script/test by default; set `ALLOW_SHARED_PRODUCTION_DB=yes-i-understand-the-risk` for that one invocation (never in `.env`) when a real DB round-trip is genuinely needed. Use a clearly-prefixed disposable test client (see `server/test/apiV1.test.js`'s `before()`/`after()`), never the demo/production accounts, for anything that writes.
- Migrations via `node-pg-migrate` (`npm run db:migrate` in `server/`), never raw SQL against the live schema.
- Two responsive breakpoints, defined once in `breakpoints.css` as CSS custom properties (reference only — `@media` conditions can't consume a custom property, so every actual media query hardcodes the literal px value): 900px tablet, 640px mobile.
- Never run `server/src/index.js` directly for anything but the real deployed server — use `createApp()` (from `server/src/app.js`) directly, listening on an ephemeral port, for any local/test/verification use.

## Last updated

2026-08-28 — mobile-responsive Phase 2 (admin panel: 18 views + 4 modals; root CRM: 11 top-level views + Settings'/Analytics' sub-tabs + 18 modals; marketing: all 6 pages), plus the admin secret-masking fixes (`retry-provisioning` forward_secret leak, `api_keys.key_hash` exposure) from the same session.
