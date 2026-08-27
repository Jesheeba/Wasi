# Wasi MCP Server — End-to-End Build Plan

## 0. What this is

An MCP (Model Context Protocol) server that exposes Wasi's existing Hub API
(`POST /api/v1/messages`, `/api/v1/templates`, webhook forwarding, etc.) as
**tools, resources, and prompts** that any MCP-compatible AI client (Claude,
Claude Code, Claude Desktop, or any other MCP host) can call directly —
the same pattern Gmail, Slack, Notion, Linear, and other major MCP servers
already ship.

This is not a new product surface bolted onto Wasi — it's a thin, well-designed
translation layer over the Hub API that already exists. Nothing in this plan
requires new backend business logic; it requires a new *interface* to logic
you've already built and hardened over this project (message sending,
interactive buttons/lists, webhook forwarding, templates).

**Goal:** a developer (or their AI agent) can type `npx @wasi/mcp-server`,
paste in an API key, and immediately have an AI assistant that can send
WhatsApp messages, check delivery status, manage templates, and read
conversation history — with zero custom integration code on their end.

---

## 1. What "good" looks like (the bar we're matching)

Looking at how Gmail's and other major MCP servers are structured, the
common traits worth matching:

| Trait | Why it matters |
|---|---|
| **Both local (stdio) and remote (Streamable HTTP) transport** | Local for Claude Desktop/Claude Code power users; remote/hosted for claude.ai, mobile, and teams who don't want to run anything themselves |
| **OAuth-style auth, not raw key paste when possible** | Reduces the chance a user pastes a secret into an insecure place; matches how Gmail/Slack MCP servers authenticate |
| **A small number of well-named tools, not a 1:1 API mirror** | Good MCP tools are task-shaped ("send_message", "get_delivery_status"), not endpoint-shaped ("post_v1_messages") |
| **Resources for read-only browsing, tools for actions** | MCP distinguishes "let the model read this" (resources) from "let the model do this" (tools) — conflating them makes for a worse client experience |
| **Structured, predictable error responses** | An agent needs to understand *why* a send failed (invalid number, template not approved, rate limited) well enough to decide whether to retry, ask the user, or give up |
| **Rate-limit and cost awareness surfaced to the model** | The model should know it's about to blow through a rate limit before it does, not find out via an opaque error |
| **Clear scoping / least privilege** | A connected MCP client shouldn't be able to do more than the API key it holds is scoped to — no "God mode" tool that bypasses your existing `client_id` isolation |
| **Good tool descriptions** | The model's only signal for *when* to call a tool is its description — vague descriptions cause the model to either never call it or call it wrongly |

---

## 2. Architecture

```
                    ┌─────────────────────────┐
                    │   MCP Client            │
                    │ (Claude, Claude Code,    │
                    │  Claude Desktop, other)  │
                    └───────────┬─────────────┘
                                │  MCP protocol (JSON-RPC over
                                │  stdio OR Streamable HTTP)
                    ┌───────────▼─────────────┐
                    │   Wasi MCP Server        │
                    │  (new — this project)    │
                    │                          │
                    │  - tools/*.ts            │
                    │  - resources/*.ts        │
                    │  - prompts/*.ts          │
                    │  - auth.ts               │
                    └───────────┬─────────────┘
                                │  HTTPS, existing Hub API
                                │  (Authorization: Bearer <key>)
                    ┌───────────▼─────────────┐
                    │   Wasi Hub API           │
                    │  (already exists)        │
                    │  /api/v1/messages        │
                    │  /api/v1/templates       │
                    │  webhook forwarding       │
                    └──────────────────────────┘
```

**Key architectural decision: the MCP server is a separate, thin service —
not code added into the existing Express app.** Reasons:
- Keeps the MCP protocol surface independent of the admin/CRM app's release cycle
- Lets it be versioned and distributed separately (npm package, Docker image)
- Avoids coupling MCP-specific auth/session concerns into `server/src`, which already has its own auth model (`requireApiKey`, `requireAdminAuth`, `requireClientAuth`)
- Matches how most companies actually ship MCP servers — as a standalone package that calls their existing public API, not as an internal fork of their app

### Two deployment modes, both needed

1. **Local (stdio transport)** — an npm package (`@wasi/mcp-server` or similar) a developer runs locally via `npx`, configured with their API key as an environment variable. This is what Claude Code / Claude Desktop users add to their MCP config.
2. **Remote (Streamable HTTP transport)** — a hosted instance (e.g. `https://mcp.wasi.example.com`) that claude.ai and other hosted MCP clients can connect to without the user running anything. This is the one that needs OAuth (see §4) since you can't hand out a long-lived static key to a hosted client the way you can to a local process.

Build local first (simpler, no OAuth needed, immediately useful for Claude Code users), then remote once local is proven.

---

## 3. Tool inventory

Map to task-shaped tools, not raw endpoints. Each tool below maps to
functionality that already exists in the Hub API/backend — this table is the
actual scope of work.

### Messaging
| Tool | Maps to | Notes |
|---|---|---|
| `send_text_message` | `POST /api/v1/messages` (`type: text`) | |
| `send_template_message` | `POST /api/v1/messages` (`type: template`) | Needs template name + param list; validate against approved templates first (see `list_templates`) |
| `send_button_message` | `POST /api/v1/messages` (`type: interactive`, `buttons`) | Enforce ≤3 buttons in the tool schema itself, so the model gets a schema-level constraint, not just a runtime error |
| `send_list_message` | `POST /api/v1/messages` (`type: interactive`, `sections`) | Enforce ≤10 total rows in the tool schema |
| `get_message_status` | new lightweight read wrapping `messages` table via existing repo | Given a `message_id`, return delivery status (sent/delivered/read/failed) |

### Conversations & contacts
| Tool | Maps to | Notes |
|---|---|---|
| `list_conversations` | existing chats/contacts read path | Paginated, filterable by contact |
| `get_conversation_history` | existing messages read path | Given a `chat_id` or `wa_id`, return recent messages both directions |
| `search_contacts` | existing contacts read path | By name/phone/tag |

### Templates
| Tool | Maps to | Notes |
|---|---|---|
| `list_templates` | `GET /api/v1/templates` | Include approval status — a model should never try to send an unapproved template |
| `get_template_details` | `GET /api/v1/templates/:id` (or equivalent) | Full param schema so the model knows what to fill in |

### Read-only account/status
| Tool | Maps to | Notes |
|---|---|---|
| `get_account_status` | WABA health equivalent, scoped to the caller's own client | Connected/disconnected, quality rating — helps the model self-diagnose "why did my send fail" |
| `get_rate_limit_status` | derived from `rateLimit.js` config + recent usage | Lets the model proactively slow down instead of hitting a 429 |

### Explicitly excluded from v1 (flag, don't build yet)
- **Anything that touches `client_webhooks`/`forward_secret` configuration.** These are secrets-adjacent and admin-controlled; exposing "configure my webhook" as an MCP tool a model can call autonomously is a meaningfully different risk profile than "send a message." Revisit only if there's a clear, scoped need.
- **Client creation / admin operations.** This MCP server should be scoped to what a single client's API key can already do — not admin-level actions. Keeps the security model identical to today's `requireApiKey` scope.
- **Anything destructive without confirmation** (e.g. no `delete_conversation` tool) unless there's a real backend equivalent and a clear need.

---

## 4. Auth model

Two tiers, matching the two transport modes from §2:

### Local (stdio) — API key via environment variable
- User sets `WASI_API_KEY` in their shell/MCP client config, same key they'd get from the "API Keys" admin view already built.
- MCP server reads it once at startup, uses it as `Authorization: Bearer <key>` on every Hub API call — no new backend auth work needed, this reuses `requireApiKey` exactly as-is.
- **Never log the key, never echo it back in a tool response, never write it to disk** beyond what the user's own MCP client config already does.

### Remote (Streamable HTTP) — OAuth 2.1 (per current MCP spec)
- This is the harder, newer piece. The MCP spec's authorization flow expects the server to act as an OAuth provider (or delegate to one).
- Recommended approach: build a lightweight OAuth wrapper *in front of* the existing API-key system — the user authorizes via a Wasi-hosted consent screen (log in with their existing Wasi admin/client credentials), and the MCP server exchanges that for a scoped, short-lived token tied to one existing API key under the hood. The underlying Hub API call still uses the existing API key — OAuth is purely the *hosted-MCP-client-facing* layer, not a backend auth rewrite.
- Do not attempt to reinvent the existing `api_keys` table/model — OAuth tokens should map to an existing key, not become a second parallel credential system.

---

## 5. Resources vs. Tools — what's browsable vs. actionable

MCP resources are for the model (or a human via the client UI) to *browse*
without side effects. Candidates:
- `wasi://templates` — list of approved templates (read-only resource, separate from the `list_templates` tool if you want both a static browse view and an active tool call)
- `wasi://account` — current account/WABA status snapshot

Keep this list small at first. Most of what this server does is genuinely
action-shaped (send a message), so tools will dominate — don't force things
into "resources" just to have some.

---

## 6. Prompts (MCP prompts feature)

Optional, but this is what differentiates a polished MCP server from a bare
tool wrapper. Candidates, each a pre-built prompt template exposed via MCP:
- `draft_confirmation_message` — given an order/booking context, draft a template-compliant confirmation message
- `draft_followup_sequence` — given a lead context, draft a 3-message nurture sequence respecting WhatsApp's template rules

These aren't required for v1 — flag as a v2 enhancement once the core tools are solid.

---

## 7. Error handling & rate limits

- **Every tool's error response must be structured and model-readable**, not a raw HTTP error dump. E.g. for `send_template_message` failing because the template isn't approved: return a clear message like `"Template 'order_confirmation' is not yet approved by Meta. Use list_templates to see approved templates."` — actionable, not just `400 Bad Request`.
- **Surface the existing 300 req/min Hub API limit proactively.** If a tool call is about to exceed it, the server should either queue/backoff transparently or tell the model clearly so it can pace itself, rather than letting the model hammer the API and get silently rate-limited.
- **Map Meta-specific errors** (invalid number, session window expired, template param mismatch) to plain-English tool errors — the model shouldn't need to know Meta's error code taxonomy.

---

## 8. Testing strategy

Reuse the same rigor established elsewhere in this project (isolated test DB,
real captured payloads, no hand-waved "should work"):
1. **Unit tests per tool** — schema validation, correct Hub API call construction, correct error mapping.
2. **Integration tests against a real (test) Wasi account** — actually call the Hub API in a sandboxed test client, the same pattern used for the interactive-message work earlier in this project (fake only the outbound Meta network call, keep everything else real).
3. **MCP protocol conformance tests** — use the official MCP SDK's test harness / MCP Inspector tool to confirm the server correctly implements the protocol (tool discovery, schema validation, resource listing) independent of Wasi-specific logic.
4. **Manual test with a real MCP client** — connect Claude Desktop or Claude Code to a local dev instance and drive a real conversation ("send a WhatsApp message to X confirming their order") before considering any milestone done.

---

## 9. Distribution & packaging

- **npm package** for the local/stdio server: `npx @wasi/mcp-server` should work with zero install step, matching how most local MCP servers are distributed today.
- **Docker image** for the remote/hosted server, deployable the same way the rest of the Wasi backend is deployed.
- **Listing in MCP directories** — once stable, submit to relevant MCP server directories/registries so it's discoverable the way Gmail/Slack/Notion's servers are, rather than only being findable via your own docs.
- **Documentation** — a dedicated MCP setup guide (separate from `crm-integration-guide.md`, which is for the raw REST API) covering: install, API key setup, example prompts, and troubleshooting.

---

## 10. Build order

Sequenced so each phase produces something demoable, not a big-bang release:

1. **Scaffold** — new repo/package, MCP SDK setup, stdio transport, hello-world tool that just calls `get_account_status`. Prove the plumbing works end-to-end with a real MCP client before building anything else.
2. **Core messaging tools** — `send_text_message`, `send_template_message`, `get_message_status`. This alone is enough for a genuinely useful v1.
3. **Interactive messaging tools** — `send_button_message`, `send_list_message`, reusing everything already hardened in the interactive-messages work.
4. **Read tools** — `list_templates`, `get_template_details`, `list_conversations`, `get_conversation_history`, `search_contacts`.
5. **Error handling & rate-limit polish** — go back through every tool from steps 2-4 and ensure errors are model-readable, not raw passthroughs.
6. **Testing pass** — full suite per §8, including a real MCP Inspector conformance check.
7. **Packaging & docs** — npm publish, setup guide, example prompts.
8. **Remote/OAuth transport** — only after local is stable and in real use; this is the highest-effort, highest-risk piece and shouldn't block getting a useful local server into developers' hands.
9. **Prompts feature (optional)** — nice-to-have, add once core tools are proven.
10. **Directory submission** — once the server has real usage and is stable.

---

## 11. Open decisions to make before building

- **Package/server name** — `@wasi/mcp-server` or similar; confirm naming doesn't collide with anything in the npm registry.
- **Which team owns the remote/hosted deployment** — the OAuth + hosting piece (§4, §9) is real infrastructure work, separate from the Hub API team's usual scope.
- **Scoping of `list_conversations`/`get_conversation_history`** — decide how much conversation history a tool call should be allowed to pull in one call (pagination limits) to avoid a single tool call returning an unbounded amount of data into the model's context.
- **Whether v1 ships local-only** — recommended: yes, ship local/stdio first, treat remote/OAuth as an explicit phase 2 once there's real demand, rather than blocking the whole project on the harder piece.
