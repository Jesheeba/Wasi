# WhatsApp CRM — Tech Provider Platform Spec
### Landing Page · Automated Client Onboarding · Admin Panel · Client Dashboard (existing)

---

## 1. What "Technical Provider of Meta" actually means for your build

Meta's program is called **WhatsApp Business Solution Provider (BSP)** / **Tech Provider**. In practice it means:

- You have a **Meta Business App** with the WhatsApp Business Platform product added.
- You use **Embedded Signup** (Meta's official JS flow) so a *client* can, from inside your product, log in with their own Facebook Business account and either connect an existing WhatsApp Business Account (WABA) or create a new one — under **your app**, but owned by **their** Meta Business Manager.
- Meta calls back your webhook/JS callback with `waba_id`, `phone_number_id`, and a temporary code. You exchange that code for a **long-lived system-user access token** scoped to that client's WABA.
- From then on, every message your platform sends/receives for that client goes through the **WhatsApp Cloud API** using that token, billed to the client's own Meta payment method (their conversations, their invoice from Meta) — or you can be the **biller** if you enroll as an actual BSP with credit line (more paperwork, usually not needed to start).
- Your app needs **App Review** for `whatsapp_business_management` and `whatsapp_business_messaging` permissions before this works for anyone outside your test roster.

This is the single most important piece: **onboarding automation = correctly implementing Embedded Signup + a provisioning backend**, not a UI problem. The UI is the easy 20%.

---

## 2. System architecture (bird's-eye view)

```
┌─────────────────┐      ┌──────────────────────┐      ┌───────────────────────┐
│   Landing Page   │─────▶│  Onboarding Wizard    │─────▶│  Provisioning Service │
│  (marketing +    │      │  (Embedded Signup +   │      │  (backend, async)     │
│   signup CTA)    │      │   plan selection +    │      └───────────┬───────────┘
└─────────────────┘      │   business details)   │                  │
                          └──────────┬────────────┘                  │
                                     │ webhook / callback             ▼
                                     ▼                     ┌──────────────────────┐
                          ┌──────────────────────┐         │   Tenant Database     │
                          │  Meta Graph API /     │◀───────▶│  (clients, WABAs,    │
                          │  WhatsApp Cloud API   │         │  tokens, plans,       │
                          └──────────────────────┘         │  usage, billing)      │
                                                            └───────────┬───────────┘
                                                                        ▼
                          ┌──────────────────────┐         ┌──────────────────────┐
                          │   Admin Panel         │◀───────▶│  Client Dashboard    │
                          │  (you, internal)      │         │  (already built —    │
                          └──────────────────────┘         │  wasi-crm-clone)      │
                                                            └──────────────────────┘
```

Four surfaces total. You have #4. You need #1, #2 (a flow, not a separate app — usually lives inside #1 or right after signup), and #3.

---

## 3. Automated onboarding flow — step by step

This replaces "someone manually creates the client's account and configures WhatsApp for them."

1. **Client clicks "Get Started" on landing page** → account creation form (business name, email, password OR Google/Microsoft OAuth) → creates a row in `clients` with status `pending_setup`.
2. **Plan selection** (Starter / Growth / Scale — see §7) → creates `subscriptions` row, triggers Stripe/Razorpay checkout (India-based, so Razorpay or Cashfree makes sense) → on payment webhook success, status → `payment_confirmed`.
3. **Embedded Signup step** (Meta's official `FB.login()` flow with `config_id` pointing to your WhatsApp configuration):
   - Client logs into their own Facebook Business Manager inside a popup.
   - They either pick an existing WABA + phone number, or Meta creates a new WABA for them under a business they own.
   - On success, Meta fires a `postMessage` event to your page with `{ waba_id, phone_number_id }`, and your backend receives a **server-side webhook** (`WABA` subscription) confirming the same, plus an authorization code.
4. **Backend token exchange**: your server calls `GET /oauth/access_token` (or the debug-token exchange for embedded signup) to convert the short-lived code into a **long-lived system user token** scoped to that WABA. Store it encrypted (KMS/Vault, never plaintext in the DB).
5. **Auto-configuration calls** (no human involved):
   - Subscribe the WABA to your app's webhook (`/subscribed_apps`).
   - Register the phone number (`/register` with a 2FA PIN you generate and store).
   - Pull the phone number's display name/quality rating and store it.
   - Create default message templates for that client (welcome message, etc.) via the Cloud API's template endpoint, submit for Meta approval automatically.
6. **Tenant provisioning**: spin up the client's logical tenant in the CRM — seed `state` equivalent in your real DB (contacts table empty, default tags, default automation rule "welcome message"), generate their subdomain or workspace slug (`clientname.yourapp.com` or `/app/{tenant_id}`), status → `active`.
7. **Welcome email + auto-login** into the client dashboard you already built, landing them straight on `chat` view with a "connected ✅" banner.
8. **Ongoing sync**: a background worker polls/listens to Meta webhooks for template approval status, phone number quality rating changes, and WABA ban/restriction events, updating `clients.waba_status` — this is what your **admin panel** surfaces.

No human touches steps 3–7. A human only intervenes if step 3 fails (e.g., client's Facebook Business Manager isn't verified) — that's a support/admin queue item, not a blocker for other clients.

---

## 4. Data model (minimum viable)

```
clients            id, name, email, password_hash, status, created_at, tenant_slug
subscriptions      id, client_id, plan, status, renews_at, payment_provider_ref
wabas              id, client_id, waba_id, phone_number_id, display_name,
                   quality_rating, access_token_encrypted, verified_at, status
message_templates  id, client_id, name, category, status(approved/pending/rejected), body
usage_logs         id, client_id, date, messages_sent, messages_received, conversations_billed
admin_users        id, name, email, role(super_admin/support/billing)
audit_log          id, actor_type, actor_id, action, target, created_at
```

Everything the **client dashboard** (`state.chats`, `state.contacts`, etc.) currently mocks in-memory needs to become tenant-scoped rows keyed by `client_id` once this is real — that's the other big rewrite: today's clone has no backend at all (per its own README, §5.3), so provisioning has nothing to attach to yet. That's priority #0 before onboarding automation matters.

---

## 5. Admin Panel — pages & components (internal, for you/your team)

| Page | Purpose | Key components |
|---|---|---|
| **Dashboard / Overview** | Health at a glance | KPI cards (active clients, MRR, messages sent today, failed onboardings), signups-over-time chart, alerts feed |
| **Clients** | List + manage every tenant | Searchable/filterable table (status, plan, WABA health), row → client detail page |
| **Client Detail** | Everything about one client | Profile card, WABA connection status + reconnect action, subscription/plan editor, usage graph, impersonate-as-client button (for support), suspend/delete actions, activity/audit log |
| **Onboarding Queue** | Where stuck signups land | List of clients stuck at each step (payment done but WABA not connected, WABA connected but templates not approved, etc.) with a manual "retry provisioning" action |
| **WABA Health Monitor** | Meta-side status across all tenants | Table of phone number quality ratings, template approval statuses, webhook subscription health, rate-limit/tier info per client |
| **Billing** | Revenue ops | Invoices, failed payments, plan changes, coupon/discount management |
| **Templates Review** (optional) | If you pre-vet templates before submitting to Meta | Approve/reject queue |
| **Support / Tickets** | Client issues | Simple ticket list, linked to client record |
| **Team & Roles** | Internal access control | Admin users table, role assignment (super admin, support, billing-only) |
| **Settings** | Platform-level config | Meta App ID/Secret, webhook URLs, default plan pricing, feature flags |
| **Audit Log** | Compliance | Every admin action, filterable |

**Shared components to build once, reuse everywhere:** data table with server-side pagination/sort/filter, status badge component (color-coded), KPI card, line/bar chart wrapper, side-drawer for detail views, confirm-action modal, toast notifications, role-gated route wrapper.

---

## 6. Landing Page — sections & components

| Section | Purpose | Notes |
|---|---|---|
| **Hero** | Value prop + primary CTA ("Start Free Trial" / "Get Started") | Should route straight into signup, not a contact form — self-serve is the point of automated onboarding |
| **Social proof strip** | Logos / client count / messages sent | Optional at launch, add once you have real numbers |
| **Feature grid** | Chat inbox, contacts/CRM, campaigns, automation, templates, analytics | Mirrors the views you already built — screenshot each |
| **How it works** | 3–4 steps: "Connect WhatsApp in 2 minutes," "Import contacts," "Send your first campaign" | This is where you *sell* the automated onboarding as the differentiator vs. manual BSPs |
| **Pricing** | Plan cards (Starter/Growth/Scale) with feature comparison table | Ties directly to `subscriptions.plan` |
| **WhatsApp Business API explainer** | Educate — many buyers don't know Cloud API vs. WhatsApp Business App | Builds trust, reduces support load |
| **Testimonials / case studies** | Once available | |
| **FAQ** | Verification requirements, message pricing pass-through, data ownership | Directly reduces onboarding drop-off |
| **Footer** | Legal (Terms, Privacy — required by Meta for WABA-handling apps), contact, status page link | Meta App Review will check you have these |
| **Signup/Get Started CTA (sticky nav)** | Always visible | |

Building blocks: nav bar w/ CTA, hero component, feature card grid, pricing table component, FAQ accordion, footer — all reusable across a few marketing pages (landing, pricing, about).

---

## 7. Suggested plans (example — tune to your costs)

| Plan | Target | Includes |
|---|---|---|
| Starter | Solo/small biz | 1 WABA number, 500 conversations/mo, chat inbox, contacts, basic automation |
| Growth | SMB | 1 WABA number, 3,000 conversations/mo, campaigns, templates, tags, analytics |
| Scale | Agencies/larger | Multiple numbers, unlimited conversations (pass-through Meta pricing), team seats, API access, priority support |

Meta bills **conversation-based pricing** to whoever owns the WABA's payment method — decide upfront whether the client pays Meta directly (simpler, less liability for you) or you consolidate billing as a real BSP (more revenue, more compliance/credit-line overhead). Most new tech providers start with the client paying Meta directly.

---

## 8. Backend services you don't have yet

Your current clone (per the README) is 100% client-side, no backend, no persistence. To support real onboarding you need, at minimum:

1. **Auth service** — client + admin login, session/JWT
2. **Provisioning service** — runs the §3 flow, idempotent, retryable, queue-backed (e.g., a job queue so a failed step 5 call retries without redoing steps 1–4)
3. **Meta webhook receiver** — public endpoint Meta calls for message events, template status, WABA status changes; fans out to the right tenant
4. **Message gateway** — wraps Cloud API send/receive calls per tenant, rate-limits per Meta's tier
5. **Billing integration** — Stripe/Razorpay for your SaaS fee; separate from Meta's own conversation billing
6. **Tenant-scoped database** — replaces the current in-memory `state` object with real persistence (Postgres is the natural fit: `clients`, `wabas`, `contacts`, `chats`, `messages`, `templates`, `automation_rules`, `tags`, all with a `client_id` foreign key + row-level isolation)
7. **Encrypted secrets store** — WABA access tokens (KMS/Vault/sealed secrets, never plain columns)
8. **Background workers** — token refresh, template status polling, usage aggregation for billing

---

## 9. Build order (recommended)

1. **Backend + real database** replacing the mock `state` object — nothing else works without this.
2. **Auth** (client + admin, separate role systems).
3. **Embedded Signup integration** in a sandbox Meta app (Meta gives you test WABAs before App Review approves you for real ones).
4. **Provisioning service** (§3) wired to the sandbox.
5. **Admin panel** — start with just Clients list + Client Detail + Onboarding Queue; everything else can wait.
6. **Landing page** — can be built in parallel by a designer/frontend dev, doesn't block backend work.
7. **Billing integration**.
8. **Submit for Meta App Review** (needs a working demo of the full flow — this is why steps 1–4 must be real before you apply).
9. Polish: WABA health monitor, analytics, support tooling.

---

## 10. Meta-side checklist (separate from your app build)

- Meta Business Manager verified (business verification, not just an FB account).
- App created in Meta App Dashboard, WhatsApp product added.
- Embedded Signup configured (`config_id`, appropriate scopes: `whatsapp_business_management`, `whatsapp_business_messaging`, `business_management`).
- App Review submitted with a screen-recording of the full client onboarding flow.
- Privacy Policy + Terms of Service URLs live (required fields in App Dashboard).
- Data deletion callback URL implemented (Meta requires this for any app touching user data).
- Webhook endpoint verified (challenge/response handshake) and subscribed to `messages`, `message_template_status_update`, `account_update`.

---

**Bottom line:** the landing page and admin panel are the visible 20% — the part that actually determines whether onboarding is "automatic" is the Embedded Signup + provisioning service in §3, which needs a real backend behind your current front-end-only clone first.
