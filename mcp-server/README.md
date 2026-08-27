# @wasi/mcp-server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for Wasi's WhatsApp Hub API. Connect it to Claude Desktop, Claude Code, or any other MCP-compatible client and your AI assistant can send WhatsApp messages, check delivery status, manage templates, and read conversations — through your own Wasi account, with zero custom integration code.

This is a thin translation layer over Wasi's existing Hub API (`/api/v1/*`) — every tool below calls a real, already-hardened backend endpoint. Nothing here is a separate product; it's a new way to reach the same platform.

## Setup

You need:
1. A Wasi Hub API key — from **Settings → Developer** inside your Wasi account (or from your Wasi admin, if you don't have self-serve access to that page).
2. The base URL of your Wasi instance.

### Claude Desktop / Claude Code

Add this to your MCP client's config (`claude_desktop_config.json` for Claude Desktop, or via `claude mcp add` for Claude Code):

```json
{
  "mcpServers": {
    "wasi": {
      "command": "npx",
      "args": ["-y", "@wasi/mcp-server"],
      "env": {
        "WASI_API_KEY": "your-hub-api-key-here",
        "WASI_API_BASE_URL": "https://your-wasi-domain.example"
      }
    }
  }
}
```

Restart your MCP client, and it will pick up 12 new tools under "wasi".

### Running from a local checkout

If you're working from this repository directly rather than the published package:

```bash
cd mcp-server
npm install
WASI_API_KEY=your-key WASI_API_BASE_URL=https://your-wasi-domain.example npm start
```

Or point your MCP client's `command`/`args` at `node` and the absolute path to `src/index.js` instead of `npx`.

## Tools

**Sending**
| Tool | What it does |
|---|---|
| `send_text_message` | Free-form text — only works within 24h of the contact's last inbound message. |
| `send_template_message` | Send an approved template — works any time, required outside the 24h window. |
| `send_button_message` | Free-form message with up to 3 tappable reply buttons. |
| `send_list_message` | Free-form message with a scrollable list (up to 10 rows total across sections). |
| `get_message_status` | Look up a previously sent message's delivery status. |

**Reading**
| Tool | What it does |
|---|---|
| `list_templates` | List every template and its Meta approval status. |
| `get_template_details` | Full definition of one template, including its parameters. |
| `list_conversations` | List recent WhatsApp conversations. |
| `get_conversation_history` | Recent messages in one conversation. |
| `search_contacts` | Look up a contact by exact phone or name/phone substring. |
| `get_account_status` | Whether a WhatsApp Business number is connected, and its quality rating. |
| `get_rate_limit_status` | The account-wide Hub API request ceiling, to pace bursts. |

Every button/row limit above (3 buttons, 10 rows) is enforced in each tool's input schema, not just at the API layer — an over-limit request is rejected before it's ever sent.

## Example prompts

- *"Send a WhatsApp text to 919876543210 saying their order has shipped."*
- *"What WhatsApp templates do I have approved for marketing?"*
- *"Check if message abc-123 was delivered."*
- *"Send an order confirmation template to this customer with their name and order number filled in."*
- *"Show me the last 20 messages in my conversation with +91 98765 43210."*

## Security

- The API key lives only in your MCP client's own config/environment — this server never writes it to disk, logs it, or includes it in any tool's returned content.
- Every tool is scoped to exactly the client account your API key belongs to (the same isolation the rest of the Hub API already enforces) — there is no way to reach another account's data through this server.
- There is no `delete_conversation` or similarly destructive tool, and nothing here can touch billing, webhook configuration, or admin-level settings — this server can only do what a single client's API key can already do via the REST API.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every tool call fails with "WASI_API_KEY is not set" | Your MCP client config's `env` block isn't reaching the process — double-check the config file, then restart your client. |
| A send fails with "outside the 24-hour customer service window" | Use `send_template_message` instead — free-form sends only work if the contact messaged you recently. |
| A template send fails immediately | Call `list_templates` — the name may be misspelled, or the template may not be approved yet. |
| "No connected WhatsApp Business number" | Connect one from the Wasi admin panel first; `get_account_status` will confirm once it's connected. |

## Scope

**In this release (local/stdio only):** everything in the tool table above, over stdio transport, authenticated by a static API key.

**Deliberately out of scope for now** (see `../wasi-mcp-server-plan.md` for the full reasoning):
- Remote/hosted transport (Streamable HTTP) and OAuth — this needs real hosting infrastructure and a token-exchange layer in front of the existing API-key system; build once there's real demand for a client that can't run a local process.
- Webhook/forwarding configuration tools — secrets-adjacent and admin-controlled today; a meaningfully different risk profile than "send a message."
- Any admin-level or cross-client operation — this server is scoped to exactly what one client's own API key can do.
- MCP prompts (pre-built prompt templates) — a v2 polish item once the core tools are in real use.

## Development

```bash
npm install
npm test              # protocol conformance + unit tests — no network, no database
npm run test:integration  # real end-to-end against the actual backend + shared DB
```

`test:integration` spins up the real Wasi backend (`server/src/app.js`) against the shared dev/production database, using a disposable, clearly-prefixed test client that's deleted afterward — the same pattern the backend's own test suite uses. It requires `ALLOW_SHARED_PRODUCTION_DB=yes-i-understand-the-risk` for that one invocation (there's no separate dev database for this project) and never sends a real WhatsApp message — only the outbound call to `graph.facebook.com` is faked.
