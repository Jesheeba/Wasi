# Connecting a Client's CRM to Wasi

How to let a client's own CRM send WhatsApp messages through Wasi's Meta
connection, and receive replies/status updates back. This is the "Hub
capability" from `wasi-build-plan.md` Phase 5 — already built and running
(`server/src/routes/apiV1Messages.js`, `apiV1Templates.js`,
`server/src/routes/admin.js`'s `/api-keys` and `/clients/:id/hub-forward`).

Nothing below requires a new Meta app or a separate WhatsApp number — the
client's own WABA, already connected via Embedded Signup, is what sends.

---

## 1. Every new client gets an API key automatically

As of this change, `POST /api/clients` (the admin panel's "Create Client"
button) auto-generates a Hub API key at the same time it creates the client
and password. The response — and the admin panel's create-client success
screen — shows it once:

```json
{
  "id": "...", "name": "...", "email": "...",
  "loginUrl": "...", "temporaryPassword": "...",
  "apiKey": "wasi_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

**Copy it immediately** — like the password, it's shown once and never
retrievable again (only its hash is stored). If it's lost, issue a
replacement from the admin panel's **API Keys** page (`Settings > API Keys`
in the nav, or `GET/POST /api/admin/api-keys`) — the old one keeps working
until explicitly revoked, so losing the display isn't an outage.

The **API Keys** page (`admin/index.html`'s "API Keys" view) is also where
you go to look up a key for an *existing* client created before this change,
issue an extra key for a second integration, or revoke one.

## 2. Hand the client's CRM developer this

**Auth**: `Authorization: Bearer <api_key>` on every request.

**Send a message** — `POST /api/v1/messages`

```bash
curl -X POST https://<wasi-host>/api/v1/messages \
  -H "Authorization: Bearer wasi_..." \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "<the client'"'"'s UUID>",
    "to": "91XXXXXXXXXX",
    "type": "template",
    "template": "order_shipped",
    "params": { "1": "Priya", "2": "#4821" }
  }'
```

- `type: "template"` — required outside the 24-hour customer-service
  window. Requires an **approved** template (see below).
- `headerMediaUrl` (only for a template whose header is IMAGE/VIDEO/DOCUMENT)
  — a public `https://` URL to *your* file for this one send (e.g. an
  invoice PDF you generated for this order). Wasi fetches it, uploads it to
  Meta, and sends with the resulting media id — no need to upload anything
  through the Wasi UI first. The URL must be reachable by Wasi's server
  without auth, and must match the header type's limits: JPEG/PNG up to 5MB
  for IMAGE, MP4 up to 16MB for VIDEO, PDF up to 100MB for DOCUMENT. Omit it
  to use the template's default approval-time sample instead.

```bash
curl -X POST https://<wasi-host>/api/v1/messages \
  -H "Authorization: Bearer wasi_..." \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "<the client'"'"'s UUID>",
    "to": "91XXXXXXXXXX",
    "type": "template",
    "template": "invoice_document",
    "params": { "1": "Priya" },
    "headerMediaUrl": "https://yourcrm.example.com/invoices/4821.pdf"
  }'
```
- `type: "text"` with `"body"` instead of `template`/`params` — only works
  within 24 hours of the customer's last inbound message (WhatsApp's
  session-message rule). Outside that window this call is rejected, not
  silently downgraded.
- `client_id` in the body must match the client the API key belongs to —
  a defense-in-depth check, not just decoration; a key can't be pointed at
  another tenant even by mistake.
- Consent: if the contact has opted out (or never opted in, depending on
  your client's consent policy), the send is rejected. This is enforced
  centrally in `messagingService.sendChatMessage`, the same function the
  Wasi chat UI itself calls — the CRM API isn't a side door around it.
- Errors come back in one consistent shape across every `/api/v1/*`
  endpoint: `{ "error": { "code": "...", "message": "...", ... } }` — a
  stable, machine-readable `code` to branch on, a human-readable `message`,
  and endpoint-specific extra fields nested alongside them (e.g. `metaError`
  with Meta's real error body attached when the rejection happened at Meta,
  not swallowed; `details` for a list of validation failures). For example:
  ```json
  { "error": { "code": "send_failed", "message": "Meta rejected the send.", "metaError": { "code": 131047, "message": "..." } } }
  ```
- **Rate limits**: every `/api/v1/*` response carries live
  `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`
  headers so a well-behaved integration can self-throttle before hitting a
  429, rather than discovering the ceiling by trial and error. The limit is
  300 requests/minute, currently scoped per source IP (also available as a
  static reference via `GET /api/v1/account/rate-limit`). A 429 response
  uses the same error shape as above: `{ "error": { "code": "rate_limited", "message": "Too many requests." } }`.

**Manage templates** — `GET /api/v1/templates`, `POST /api/v1/templates`
(same auth). A template must be Meta-approved before it can be used in a
`type: "template"` send; submitted templates go through the normal
approval turnaround (minutes to a day, per Meta).

## 3. Inbound forwarding (replies, template/account status)

So the client's CRM finds out when a customer replies, or when one of its
templates gets paused/rejected by Meta, without polling Wasi.

In the admin panel, open the client's detail page (**Clients → [client
name]**) — once their WABA shows "connected," a **CRM Inbound Forwarding**
section appears in the WhatsApp Business Account card. Enter the CRM's
webhook URL and tick which events to forward, then Save. Equivalent API:

```bash
curl -X POST https://<wasi-host>/api/admin/clients/<client_id>/hub-forward \
  -H "Authorization: Bearer <admin JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "forward_to_url": "https://client-crm.example.com/webhooks/wasi",
    "events": ["message.received", "message_template_status_update", "account_update"]
  }'
```

Deliveries are signed `x-wasi-signature-256: sha256=<hmac>` (HMAC-SHA256 of
the raw JSON body, keyed by a per-WABA secret) so the receiving CRM can
verify origin. Delivery is queued and retried with backoff
(`webhookDeliveriesRepo`), not fire-and-forget.

**Event types available today**: `message.received` (a customer's reply),
`message.status` (per-message delivery lifecycle, `sent → delivered → read
→ failed`), `message_template_status_update` (Meta approved/paused/rejected
a template), `account_update` (WABA restriction/ban/quality changes). All
four are live and wired into `enqueueForwards`
(`server/src/routes/metaWebhook.js`) — this paragraph previously said
`message.status` wasn't forwarded yet; that was corrected once it shipped
(migration `032_widen_forward_events.js`).

## 4. What's still manual per client

- **Inbound forwarding URL** — inherently client-specific, can't be
  automated at client-creation time; also requires their WABA to already
  be connected (no WABA = nothing to forward from yet). Set it once you
  have the CRM's real webhook URL, via the client detail page above.
- **Template creation** — a CRM can submit templates via
  `POST /api/v1/templates`, but Meta's approval is not instant; don't
  build a client integration that assumes same-request approval.

## Scope note

This auto-generates a key for clients **created by an admin** via
`POST /api/clients` (the normal Sirah-team onboarding flow). Self-signup
(`POST /api/auth/register`, the public marketing signup page) does **not**
get one automatically — there's no admin in that loop to hand the key off.
A self-signed-up client isn't stuck without one, though: **Settings →
Developer** in the root CRM app is a full client-authenticated `/api/api-keys`
surface — list, create (`POST /`, shows the raw key once), revoke, and
delete, all scoped to the caller's own account (`server/src/routes/apiKeys.js`).

## 5. No-code connector: Zapier (private/beta)

For a client who wants message automation without writing integration code
at all, `zapier-app/` is a private/beta Zapier Platform CLI app built on
top of everything above — same `POST /api/v1/messages` for its "Send
WhatsApp Message" action, same Bearer API key auth (a client pastes their
own key from Settings → Developer into Zapier's connection dialog, no
different in kind from handing it to a CRM developer above). Its "New
WhatsApp Message Received" trigger is an instant REST Hook, riding the
exact same `webhook_deliveries`/`forwardRunner.js` queue described in
§3 above, via a new per-Zap subscription (`POST`/`DELETE
/api/v1/subscriptions`) rather than the single `forward_to_url` this
section covers. See `zapier-app/README.md` for setup and scope — not
submitted to Zapier's certified app directory yet.
