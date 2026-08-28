# Wasi — Project Context (auto-loaded by Claude Code)

## What this is

Wasi is a WhatsApp Business CRM: a client-facing app (chat inbox, contacts, campaigns, templates, automation), an internal admin panel for onboarding/operating client accounts, and a public marketing/signup site — all backed by a real Express + Postgres backend on Meta's WhatsApp Cloud API. A Hub API (`/api/v1/*`) and an MCP server let third-party apps and AI assistants send messages and read data through a client's own account.

## Architecture summary

Plain CommonJS Node, no build step, no TypeScript. Three static-HTML/vanilla-JS surfaces sharing one Express backend (`server/`):
- **Root CRM app** (`index.html`/`index.css`/`app.js`) — the logged-in client app.
- **`admin/`** — the internal ops console (separate login, `requireAdminAuth`).
- **`marketing/`** — public landing page + signup wizard, no auth.
- **`mcp-server/`** — standalone npm package wrapping the Hub API as MCP tools for AI clients (local/stdio transport only).

See `server/README.md` for the API surface and background workers, `DEPLOY.md` for production deploy, `crm-integration-guide.md` for the Hub API's own docs (distinct audience from this file — see the Update mechanism section below), `wasi-master-plan.md` for the long-range feature roadmap this table tracks against.

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
| Hub API v1 — consistent error shape + rate-limit headers | Complete + verified (2026-08-28) | `server/src/utils/apiError.js`, `server/src/middleware/apiV1ErrorHandler.js`, `server/src/middleware/rateLimit.js`'s `apiLimiter` | `crm-integration-guide.md`, this file's Conventions section |
| Living documentation (this file + update mechanism) | Complete + verified | `CLAUDE.md` (this file) | Update mechanism section below |
| Template Library | Not started | — | `wasi-master-plan.md` §2 |
| Integrations Marketplace | Not started | — | `wasi-master-plan.md` §3 |
| Broadcast/Campaign Engine | Not started (root app's Campaigns view is a static mock; partial DB schema exists — `broadcast_recipients`, `broadcast_param_mappings`, `broadcast_header_media` migrations — but no `contact_lists`/`broadcasts` orchestration or real UI) | `db/migrations/007,026,031` | `wasi-master-plan.md` §8.3 |
| Chatbot/Automation Flow Builder | Has a spike, not shipped as the primary flow-building surface. `automation_flows`/`flow_edges`/etc. tables exist (migrations 023-029); whether they're fully wired end-to-end to the visual builder is unconfirmed as of this writing | `flow-editor/` (React Flow, separate from root app's in-CRM bot-flow-editor modal), `db/migrations/023-029` | `wasi-master-plan.md` §8.4 |
| Shared Team Inbox | Not started — no `agents`/`conversation_assignments`/`internal_notes` tables exist yet | — | `wasi-master-plan.md` §8.5 |
| OAuth "Connected Apps", API versioning policy, deprecation-header mechanism | Not started | — | `wasi-master-plan.md` §8.6 |

## Known gaps / deliberately deferred

- **MCP remote/OAuth transport** — deferred, local/stdio only for now (see `mcp-server/README.md` Scope section).
- **`npm publish` for `@wasi/mcp-server`** — deliberately not published yet; the package is fully installable from a repo checkout, and the `npx @wasi/mcp-server` command referenced in docs/UI will start working the moment it is.
- **Root CRM dead views/sub-tabs** — `view-ecommerce`, `view-whatsapp-flows`, `view-ctwa` (main nav), and Analytics' `rep-view-flow`/`rep-view-api`/`rep-view-live-chat`/`rep-view-operator-stats` sub-tabs exist in the DOM with full markup but have no nav item pointing to them (intentionally hidden, commit `946a8ec`). Confirmed dead, not audited or fixed as part of the mobile-responsive pass.
- **`api_keys.key_hash` exposure** — was leaking in 2 admin routes (`POST /api-keys`, `POST /api-keys/:id/revoke`), fixed 2026-08-28. Low severity (unsalted SHA-256 of a 24-byte random key, not practically reversible) but worth knowing the history if it resurfaces via a future `returning *` route.
- **Root CRM modals beyond Chat/Contacts/Settings/Analytics** — `list_reply` inbound webhook handling was built from Meta's spec and is unverified against a real capture as of the interactive-messages work.
- **Hub API v1 rate-limit visibility is scoped per source IP, not per API key** — deliberate: this project hasn't stood up per-key usage-tracking infrastructure, and building it wasn't in scope for the error-shape/rate-limit-header phase's "cheap wins" pass. `GET /api/v1/account/rate-limit` and the `X-RateLimit-*` headers both say this honestly rather than claim accuracy they don't have (the response text previously said "per API key," which was wrong — corrected 2026-08-28).
- **OAuth "Connected Apps," the API versioning policy, and the `X-Wasi-API-Deprecation` header mechanism** (`wasi-master-plan.md` §8.6) — explicitly deferred past the error-shape/rate-limit-header phase, not built. Needed before Zapier (or any third-party partner) goes from private/beta to real distribution.
- **Client self-serve API key issuance** — still admin-only; a client can list/revoke/delete their own keys but not mint a new one without contacting support.
- **502 error paths on Hub API v1 writes are functionally correct but untested end-to-end** — `send_failed` (`apiV1Messages.js`) and `meta_template_rejected` (`apiV1Templates.js`) both require a connected WABA plus a faked Meta rejection to exercise; this gap predates the error-shape phase (never covered at any point in this repo's history) and wasn't closed by it — a real hole worth a follow-up test, not a regression.

## Conventions this codebase follows

- Plain CommonJS, no TypeScript, no bundler on any of the three front-end surfaces.
- Backend tests: `node --test` (built-in runner), no jest/mocha. Outbound Meta calls are faked by stubbing `global.fetch` for `graph.facebook.com` URLs only — never the app's own local-server fetches.
- **Local `DATABASE_URL` is the same shared Supabase instance as production** — there is no separate dev database. `server/src/utils/dbSafety.js` refuses any DB-touching script/test by default; set `ALLOW_SHARED_PRODUCTION_DB=yes-i-understand-the-risk` for that one invocation (never in `.env`) when a real DB round-trip is genuinely needed. Use a clearly-prefixed disposable test client (see `server/test/apiV1.test.js`'s `before()`/`after()`), never the demo/production accounts, for anything that writes.
- Migrations via `node-pg-migrate` (`npm run db:migrate` in `server/`), never raw SQL against the live schema.
- Two responsive breakpoints, defined once in `breakpoints.css` as CSS custom properties (reference only — `@media` conditions can't consume a custom property, so every actual media query hardcodes the literal px value): 900px tablet, 640px mobile.
- Never run `server/src/index.js` directly for anything but the real deployed server — use `createApp()` (from `server/src/app.js`) directly, listening on an ephemeral port, for any local/test/verification use.
- Secret/credential leak discipline: this project has shipped two real leak bugs to production (`forward_secret` via a hand-rolled destructure; `key_hash` via `returning *` + spread) — both fixed by (a) reusing one shared masking/shaping helper across every route returning the same shape rather than hand-rolling per-route, (b) auditing every sibling route returning the same table/shape while in there, (c) adding regression test coverage in the same change. Apply this discipline to any new response shape.
- **Hub API v1 (`/api/v1/*`) error responses**: always `{ "error": { "code": "...", "message": "...", ...optional extra fields } }` — never a bare string or a route-specific ad-hoc shape. Use `server/src/utils/apiError.js`'s `sendApiError()` for a known failure in a route handler; anything thrown (Zod, Postgres constraint violation, uncaught) is normalized by `server/src/middleware/apiV1ErrorHandler.js`. This shape is scoped to `/api/v1/*` only — admin/marketing/client-CRM routes keep the pre-existing `{ error: "string" }` shape via `server/src/middleware/errorHandler.js`, unchanged. Every `/api/v1/*` response also carries live `X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset` headers (`rateLimit.js`'s `apiLimiter`, `legacyHeaders: true`).
- Feature-inventory status column uses three states — *Not started / In progress / Complete + verified* (*Live* is used interchangeably with *Complete + verified* for pre-existing shipped capability). Don't mark something without real test evidence.

## Update mechanism (how this file stays current)

1. Every build prompt for a new feature ends with an explicit "update CLAUDE.md" instruction, and a build isn't complete without it — same bar as a build without tests.
2. Keep this file, `crm-integration-guide.md`, and the in-app API Guide (`admin/index.html`'s "API Guide" view) in sync but distinct: this file is for Claude Code/internal developers (architecture, conventions, status); the other two are for external developers integrating (endpoints, auth, examples). They overlap in content but serve different readers — don't merge them.
3. Update the feature-inventory table's status honestly, using the three states above — never mark something "Complete + verified" or "Live" without real test evidence.
4. If two sessions touch this file concurrently (this project's local DB is shared, and more than one Claude Code session may be active against the same working tree at once — confirmed to happen in practice), **merge, don't overwrite**: read the currently-committed version first, keep its content intact, and add/update only the rows and sections your own change actually affects.

## Last updated

2026-08-28 — mobile-responsive Phase 2 (admin panel: 18 views + 4 modals; root CRM: 11 top-level views + Settings'/Analytics' sub-tabs + 18 modals; marketing: all 6 pages), the admin secret-masking fixes (`retry-provisioning` forward_secret leak, `api_keys.key_hash` exposure), and — same day, separate session — the Hub API v1 error-shape/rate-limit-header uplift (`wasi-master-plan.md` §4 + §8.6's cheap parts; OAuth and the API versioning policy are later phases, not built this pass) plus this file's own creation/update mechanism.
