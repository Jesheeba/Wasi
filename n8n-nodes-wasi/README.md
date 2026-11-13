# n8n-nodes-wasi

An [n8n](https://n8n.io) community node for [Wasi](https://wasi.sirahagents.com)'s
WhatsApp Business Hub API (`/api/v1/*`) — send messages, manage templates, look up
contacts/conversations, and register webhook subscriptions, from inside any n8n
workflow. Wraps the same 12 Hub API endpoints the `mcp-server/` package in the Wasi
repo exposes as MCP tools, as n8n actions instead.

## No-install alternative: `wasi-n8n-hub-api-examples.json`

If a client doesn't want to install a community node at all (no SSH/filesystem access
to their n8n instance, or it's n8n Cloud, which blocks community packages entirely),
send them [`wasi-n8n-hub-api-examples.json`](wasi-n8n-hub-api-examples.json) instead.
It's a plain n8n workflow — import it via **Workflows → Import from File** — built
entirely from n8n's own built-in HTTP Request node, so there is nothing to install.
It has:

- one **Wasi Config** node where they paste their Base URL, API Key, and Client ID
  once
- one HTTP Request node per Hub API action (the same 12 covered by the node package),
  pre-filled with the right method/URL/auth header/body shape, ready to copy into
  their own workflows or run directly from **Test workflow**

This has no credential-sharing step either — n8n credentials aren't portable across
instances via a plain workflow export, so the config values live as plain fields on
the **Wasi Config** node instead; the client edits them once after import.

### Quick test: `wasi-send-template-test.json`

A smaller, focused version of the above for testing one thing: sending a template
message. Import it the same way (**Workflows → Import from File**). It has 4 nodes:

1. **When clicking 'Test workflow'** — the manual trigger
2. **Wasi Config** — paste Base URL / API Key / Client ID
3. **List Templates (find a real template name)** — `GET /api/v1/templates`, run
   this first to see your real template names, languages, and approval status
4. **Send Template Message** — `POST /api/v1/messages`, edit the `to` phone number
   and `template` name (and `params` if the template has variables) to match a real
   approved template from step 3, then run it

A template must already be synced locally in Wasi (`POST /api/templates/sync`, or
just open the Templates view in the CRM once) before step 4 will find it —
otherwise it 404s with `template_not_found`.

## Resources and operations

| Resource | Operations |
| --- | --- |
| Account | Get Status, Get Rate Limit |
| Contact | Search (by phone or name/phone substring) |
| Conversation | List, Get Messages |
| Message | Send (text / template / interactive), Get Status |
| Template | List, Get, Create |
| Webhook Subscription | Subscribe, Unsubscribe |

## Install

### In an n8n instance you manage (Community Nodes, recommended)

1. Build this package once (see "Build from source" below), then publish it to a
   private npm registry, or `npm pack` it and install the resulting `.tgz`.
2. In n8n: **Settings → Community Nodes → Install**, enter the package name
   (`n8n-nodes-wasi`) or point it at the `.tgz`.
3. A new **Wasi** node appears in the node panel.

### Manual install (self-hosted / Docker)

```bash
cd n8n-nodes-wasi
npm install
npm run build
# copy (or npm link) the built package into n8n's custom nodes directory,
# typically ~/.n8n/custom or ~/.n8n/nodes, then restart n8n
```

n8n Cloud does not allow installing arbitrary community packages — use a
self-hosted n8n instance for this node.

## Credentials

Create a **Wasi API** credential with:

- **Base URL** — your Wasi instance's base URL, e.g. `https://wasi.sirahagents.com`
  (no trailing slash)
- **API Key** — a Hub API key created in the Wasi CRM under **Settings → Developer**
  (or by an admin, for a client account)
- **Client ID** — the `client_id` shown next to that API key. Required by the
  **Message → Send** action as a defense-in-depth check (Wasi's own API rejects a
  send whose `client_id` doesn't match the key); every other action only needs the
  API key.

The credential's "Test" button calls `GET /api/v1/account`.

## Notes carried over from the Hub API itself

- **Send → Template**: the template must already be synced locally in Wasi
  (`POST /api/templates/sync`) so its real approved language can be resolved —
  sending by name alone before a sync returns `template_not_found`.
- **Send → Template, Authentication category**: put the one-time code as the single
  entry in *Template Params*, e.g. `{"code": "123456"}` — Wasi builds the body +
  Copy Code button pair for you.
- **Send → Interactive**: choose exactly one subtype (Reply Buttons or List) — Wasi's
  API rejects a request that sets both.
- Rate limits, error shapes, and every field above are documented in the main Wasi
  repo's `crm-integration-guide.md`.

## Build from source

```bash
npm install
npm run build   # compiles TypeScript to dist/, copies the icon alongside it
```

## License

MIT
