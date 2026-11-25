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
- **Authentication (OTP / Copy code) templates**: pass the one-time code as
  the only param, under any key — `"params": { "code": "123456" }`. Wasi
  sends it as both the body parameter and the Copy code button's parameter,
  which Meta requires (you don't build the button component yourself).
  `params` must have exactly one entry, a non-empty string or a number
  (numbers are sent as text). Anything else — no params, several params,
  null/boolean/object/array/empty values, or a code over 15 characters
  (Meta's limit) — is rejected with `auth_code_invalid` (409) and a message
  saying what was wrong; nothing is sent to Meta.
- **Only approved templates send.** A template that is still pending Meta's
  review, or rejected, paused or disabled, is refused with
  `template_not_approved` (409); nothing is sent to Meta. Wasi re-checks the
  status with Meta once before refusing, in case its copy is stale. An
  approved template that you edited stays sendable while Meta re-reviews it
  (Meta keeps sending the old approved version).
- `client_id` in the body must match the client the API key belongs to —
  a defense-in-depth check, not just decoration; a key can't be pointed at
  another tenant even by mistake.
- **Marketing consent** (Marketing templates only; Utility and
  Authentication are not affected). Enforced centrally in
  `messagingService.sendChatMessage`, the same function the Wasi chat UI
  calls, so the CRM API isn't a side door around it:
  - contact opted out (e.g. replied STOP) → `contact_opted_out` (409),
    always. Don't retry; only the contact can opt back in.
  - contact opted in → sent.
  - opt-in not recorded → sent only if the business owner or an Admin has
    confirmed in Wasi **Settings > Marketing consent** that the business
    collects opt-in; otherwise `consent_required` (409).
  - To record opt-in from your own system, add
    `"optIn": { "method": "website_form", "note": "optional" }` to the send.
    It is recorded before the send, with your API key as the source.
    `method` is one of `website_form`, `in_store`,
    `existing_customer_agreement`, `other`. An opt-in for an opted-out
    contact is refused with `contact_opted_out` and nothing is sent.
  - Or record consent separately:
    `POST /api/v1/contacts/consent` with
    `{ "phone": "9198...", "status": "opted_in", "method": "website_form" }`
    (or `"status": "opted_out"`, no method needed). Creates the contact if
    it's new; returns `id`, `phone`, `opt_in_status`, `opt_in_at`,
    `opt_out_at`.
  - Passing `optIn` or `status: "opted_in"` means you confirm that this
    person agreed to receive WhatsApp marketing from the business and that
    the business can show evidence of it.
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

Templates with an **image, video or document header** need the file at
submission time (Meta reviews the sample). Send it one of two ways:

- **Multipart upload**: `multipart/form-data` with the file in a `file`
  part and the template JSON (same fields as a plain submit) in a `data`
  part:
  ```bash
  curl -X POST https://wasi.sirahagents.com/api/v1/templates     -H "Authorization: Bearer <API key>"     -F 'data={"name":"event_reminder","category":"Marketing","language":"en_US","header":{"type":"IMAGE"},"body":"See you at the event on 12 December."}'     -F "file=@poster.jpg;type=image/jpeg"
  ```
- **Public URL**: plain JSON with `"headerMediaUrl": "https://..."` (a
  public https file; Wasi downloads it).

**Category changed by Meta.** Meta may approve a template in a different
category from the one you submitted (most often Utility approved as
Marketing). The create response then has `"category": "Marketing"`,
`"previous_category": "Utility"` and a `warnings` array explaining it.
Template objects from `GET /api/v1/templates` also carry
`previous_category`, `category_changed_at` and, when Meta has announced a
change that has not happened yet, `upcoming_category` /
`upcoming_category_at`. Marketing templates follow the consent rules
above (opted-in contacts, or any not-opted-out contact once the business
has confirmed it collects opt-in).

Limits: IMAGE JPEG/PNG up to 5MB, VIDEO MP4 up to 16MB, DOCUMENT PDF up to
100MB. Error codes: `header_media_required`, `invalid_header_media`,
`unexpected_header_media`, `invalid_upload`, `whatsapp_not_connected`
(409), `template_name_taken` (409, same name + language already exists),
`header_media_upload_failed` (502). The uploaded file also becomes the
template's default header for sends, so nothing more is needed once Meta
approves it. Carousel templates are not supported through the API yet.

**Daily sending limit** — `GET /api/v1/account` includes
`messaging_limit`: `tier`, `limit_per_24h`, `used_last_24h`,
`remaining`, `unlimited`, `checked_at`. Meta caps how many unique
people a number can message first (outside an open 24-hour customer window)
per rolling 24 hours, and rejects sends over it. `used_last_24h` is Wasi's
estimate from messages sent through Wasi. Check `remaining` before a bulk
run and send in batches that fit.

### API versioning & deprecation policy

The Hub API is versioned in its path (`/api/v1/...`) and this policy governs
what can change under that version without breaking your integration, and
what requires a new one.

**Non-breaking (ships any time, no notice needed):**
- Adding a new optional request field.
- Adding a new field to a response.
- Adding a new endpoint.
- Loosening a validation rule (accepting something that used to be rejected).

**Breaking (requires the deprecation process below, never shipped silently):**
- Removing a response field, or changing its type or meaning.
- Removing an endpoint, or making an optional request field required.
- Tightening a validation rule (rejecting something that used to be
  accepted).

**The deprecation process, when a breaking change is unavoidable:** the old
behavior keeps working, but every response from the deprecated
endpoint/field carries:
- `X-Wasi-API-Deprecation: true`
- `X-Wasi-API-Deprecation-Sunset: <YYYY-MM-DD>` — the date it stops working
- `X-Wasi-API-Deprecation-Info` — what to migrate to, when present

Minimum notice: **90 days** between the first response carrying these
headers and the sunset date. Check for `X-Wasi-API-Deprecation` on your
responses periodically rather than finding out at the sunset date itself.

As of this writing, nothing in `/api/v1/*` is deprecated.

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

**Completed WhatsApp Forms** arrive as a normal `message.received`. Its
`body` is readable text ("Form submitted: <form>" followed by one
"Label: answer" line per field). Its `interactive` field is
`{ "type": "nfm_reply", "flow_token": "wasi_flow:<form id>", "response": { ...raw answers } }`.
Dropdown answers in `response` are option ids (`opt_1`, `opt_2`, ...);
`body` already shows the option text.

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
