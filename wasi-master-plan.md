# Wasi — Complete Product Plan (Full Build: Template Library, Integrations, API Maturity, Competitive Parity & Beyond)

## 0. Sources and method

This plan is grounded in real research, not assumption:
- Real fetches of AiSensy's Template Library and Integrations pages.
- Real fetches of three Salesforce REST API Developer Guide pages: Status
  Codes and Error Responses, Headers, and OAuth/Connected Apps.
- A round of web research across independent, current (2026) comparison
  sources covering the WhatsApp BSP market, cross-referenced rather than
  taken from any single source, to build the top-10 competitive list and
  feature superset in §5-6.
- Everything Wasi already has today, established across this entire
  project (Hub API, webhook forwarding, interactive messages, MCP server,
  admin panel, client self-serve key management, security hardening).

All content described as "build this" below is **originally authored
capability**, not copied material. AiSensy's and others' marketing copy,
template text, and page content are their IP — this plan uses their pages
only as a reference for *what capabilities to build*, never as source text
to reproduce. Meta approval requires content tailored to each business
anyway, so copying wouldn't even work in practice.

---

## 1. What "10/10, no bugs, perfect delivery" means for this plan

Given the standard already set across this project, that's not a vibe, it's
a checklist applied to every phase below:

1. Every new feature has real backend logic, not a UI shell over nothing.
2. Every DB change is additive/nullable where possible, confirmed against
   the shared dev/prod DB before running.
3. Every claim of "done" is backed by real test output (isolated test
   client + real DB, faked only at the Meta network boundary) — never
   "should work."
4. Every new public-facing surface is checked against the exact leak
   pattern already found and fixed twice in this project — a `returning *`
   or object-spread that forgets to strip a sensitive field.
5. Nothing ships without an update to the living documentation system (§4)
   — a feature isn't done until the docs describe it accurately.

---

## 2. Feature 1 — WhatsApp Template Message Library

### 2.1 What it is
A browsable, curated library of pre-built, Meta-policy-compliant WhatsApp
message templates, organized by industry and use case, that a client can
preview, customize, and submit for approval in a few clicks instead of
writing one from scratch and guessing whether Meta will approve it.

### 2.2 Data model
New table, additive, admin-owned:

```
template_library
  id                 uuid PK
  industry           text        -- 'ecommerce' | 'education' | 'healthcare' | ...
  use_case           text        -- 'abandoned_cart' | 'appointment_reminder' | ...
  category           text        -- MARKETING | UTILITY | AUTHENTICATION (Meta's own categories)
  title              text        -- human-readable name shown in the library UI
  header_type        text nullable   -- TEXT | IMAGE | VIDEO | DOCUMENT | none
  header_content     text nullable
  body               text        -- the actual template body, with {{1}}, {{2}} placeholders
  footer             text nullable
  buttons_json        jsonb nullable  -- quick-reply / CTA button definitions
  sample_values_json  jsonb       -- example values for each {{n}} variable (Meta requires these)
  language            text default 'en'
  is_active           boolean default true
  created_by_admin_id uuid FK -> admins
  created_at / updated_at
```
Indexed on `(industry, category)` and `(use_case)`.

### 2.3 Content — the actual 100+ templates
Real content work, not just schema. Build in batches, all originally
authored to Meta's WhatsApp Business Messaging Policy (clear intent, correct
category, no pushy/spammy language, sample values on every variable, no
variables at the very start/end of the body — these are the exact rejection
reasons Meta commonly cites):
- Minimum 8 industries: E-commerce, Education, Healthcare, Finance, Travel,
  Automobile, Events & Webinars, General/Other.
- Minimum 10-15 templates per industry, spanning all relevant Meta
  categories, covering the highest-value use cases per industry (e.g.
  e-commerce: abandoned cart, order confirmation, shipping update, delivery
  confirmation, review request, restock alert, promotional offer, COD
  confirmation, refund processed).
- Each template must be manually checked against Meta's actual rejection-
  reason list before going live — don't just write plausible-looking copy
  and hope it's approved on a real client's first submission.

### 2.4 AI Template Generator (v2, not v1)
Given a plain-language description ("send customers a reminder 24h before
their salon appointment"), generate a draft template body + suggested
category + sample values via a server-side LLM call. Build as v2, once the
static library is live and proven — don't let this block v1.

### 2.5 UI flow
- New nav view (admin + client-facing app): **Template Library**, filterable
  by industry/category/use case, with a live preview rendering the template
  the way it'll actually look on WhatsApp.
- "Use this Template" → opens the existing template-creation flow pre-filled
  with the library entry's content, editable before submission — reuses the
  existing template-creation/Meta-submission backend entirely; this is
  purely a pre-fill UX layer, no new submission logic.
- Track usage via a lightweight `template_library_usage` join
  (library_template_id + client_id + created_at) — cheap now, useful data
  for knowing what to expand later.

### 2.6 What NOT to build in v1
- No promise of guaranteed Meta approval — message as "pre-vetted against
  Meta's policy, first-attempt approval rates are higher," never
  "guaranteed."
- No full admin CMS for editing library content in v1 — seed via
  migration/script first, add an editing UI only once the library is proven
  and needs to grow past what a script reasonably manages.

---

## 3. Feature 2 — Integrations Marketplace

### 3.1 Three tiers, build in this order

**Tier 1 — Native integrations (build first, limit to 2 in v1)**
- **Shopify** — order created → confirmation template; cart abandoned →
  recovery template. Highest-value integration in this category industry-wide.
- **Razorpay** (or local equivalent) — payment link generated → send on
  WhatsApp; payment received → send confirmation.
Each is genuine new backend work: a webhook receiver for the third-party
platform's events, mapped to Wasi's existing `send_template_message` logic —
same shape as the inbound WhatsApp webhook work already done (receive,
validate signature, translate, forward), just a different upstream sender.

**Tier 2 — No-code connector (Zapier) — highest leverage item in this entire plan**
Ship **one Zapier app** exposing the Hub API as triggers/actions:
- Trigger: "New WhatsApp Message Received"
- Action: "Send WhatsApp Message" (text/template/button/list — reuse the
  existing Hub API + MCP server's tool logic as the underlying
  implementation; this is the third consumer of the same core sending
  logic, not new logic).
This one build unlocks the same "2000+ integrations" claim AiSensy makes,
because Zapier itself already connects to thousands of apps — you're
building one bridge to an ecosystem that already exists, not building 2000
integrations yourself.

**Tier 3 — Public API + documented webhook (already exists)**
The Hub API + webhook forwarding pipeline built earlier in this project.
Just needs to be **surfaced** in the Integrations Marketplace UI as "Custom
Integration (API)," pointing at the existing API Guide — not rebuilt.

### 3.2 UI
New nav view: **Integrations**, admin + client-facing, three sections
matching the tiers, each card showing name, description, and a connect/
configure button (Tier 1), "Connect via Zapier" link (Tier 2), or "View API
Docs" link (Tier 3). Include a **"Request an Integration"** form (mirrors
AiSensy's own pattern) — cheap to build, gives real signal on what to build
next instead of guessing.

### 3.3 What NOT to build in v1
- No more than 2 Tier-1 native integrations before the first two are proven
  working end-to-end with a real client — each is genuine, non-trivial
  backend work, don't parallelize past what can be properly tested.
- No Zapier "Premium/certified app" submission as a day-one goal — build and
  test as private/beta first, submit for certification once proven with
  real usage.

---

## 4. Living Documentation System — the part that updates itself

This is the mechanism that keeps documentation matching reality instead of
drifting stale after the first few features — which already happened once
in this project (`crm-integration-guide.md` didn't reflect several features
built after it was written; the client Developer page sat disconnected for
a while before being fixed).

### 4.1 One file Claude Code always reads first: `CLAUDE.md`
Create (or formalize) a `CLAUDE.md` at the repo root — Claude Code and other
agentic tools read project-root context files like this automatically at
the start of a session. This becomes the single source of truth a new
session or developer reads before touching anything:

```markdown
# Wasi — Project Context (auto-loaded by Claude Code)

## What this is
[2-3 sentence description of the product]

## Architecture summary
[Plain CommonJS Node, no build step, three surfaces: root CRM app, /admin,
/marketing. Hub API v1 for third-party integrations. See §X for detail docs.]

## Feature inventory (update this table every time a feature ships)
| Feature | Status | Where | Docs |
|---|---|---|---|
| WhatsApp send (text/template/button/list) | Live | Hub API v1 | crm-integration-guide.md |
| Webhook forwarding to client CRMs | Live | forwardRunner.js | crm-integration-guide.md §3 |
| MCP server | Live (local/stdio only) | mcp-server/ | mcp-server/README.md |
| Client self-serve API key mgmt | Live | /api/api-keys | (this file, §X) |
| Template Library | [status] | | |
| Integrations Marketplace | [status] | | |
| Broadcast/Campaign Engine | [status] | | |
| Chatbot/Automation Flow Builder | [status] | | |
| Shared Team Inbox | [status] | | |

## Known gaps / deliberately deferred
[e.g. "MCP remote/OAuth transport — deferred, local/stdio only for now"
"list_reply inbound handling — built from Meta's spec, unverified against a
real capture as of <date>"]

## Conventions this codebase follows
[Plain CommonJS, no TS. node --test, no jest/mocha. Migrations via the
project's migration tool, never raw SQL. Local DATABASE_URL is the shared
dev/prod DB — always confirm before running migrations.]

## Last updated
[date, and which feature/session triggered the update]
```

### 4.2 The actual update mechanism
A living doc nobody remembers to update goes stale immediately. Make it
structurally hard to skip:

1. **Every build prompt for a new feature ends with an explicit "update
   CLAUDE.md" instruction** — a standing line in the prompt template (§9.2),
   not something remembered ad hoc.
2. **A missing CLAUDE.md update makes a build incomplete**, the same way a
   build without tests is incomplete. Claude Code's completion report should
   show the CLAUDE.md diff every time.
3. **Keep `crm-integration-guide.md`, the in-app API Guide, and CLAUDE.md
   in sync but distinct**: CLAUDE.md is for Claude Code/internal developers
   (architecture, conventions, status); the API Guide is for external
   developers integrating (endpoints, auth, examples). They overlap in
   content but serve different readers — don't merge them, keep them
   separately maintained and cross-referenced.
4. **Version the feature-inventory table's status column honestly** — use
   the same three states used throughout this project: *Not started / In
   progress / Complete + verified*. Don't mark something "Live" without real
   test evidence.

### 4.3 What this buys you
The next time anyone asks "is everything okay?" or "what are we doing?" —
the honest, current answer is already written down in one file, instead of
requiring a multi-message audit the way status drift has required more than
once already in this project.

---

## 5. The competitive set — top 10 WhatsApp Business API platforms, as they actually stand in 2026

Cross-referenced across multiple independent comparison sources rather than
one vendor's own marketing. The market splits into three real tiers:

| Tier | Platforms | Character |
|---|---|---|
| **Developer/enterprise infrastructure** | Twilio, Infobip, Gupshup, 360dialog | Deep API access, omnichannel (SMS/RCS/voice/Instagram alongside WhatsApp), high scale, less out-of-the-box UI |
| **SMB/mid-market all-in-one** | Wati, AiSensy, Interakt, Gallabox | Shared inbox + no-code chatbot + broadcasts + commerce integrations, minimal engineering required |
| **AI-first / omnichannel CX** | Respond.io, Yellow.ai | AI agents/copilot as the primary differentiator, multi-channel beyond just WhatsApp |

Wasi's current shape (Hub API + admin panel + interactive messages + MCP
server) sits closest to the developer/enterprise tier technically, but
without yet having the SMB-tier UI layer that most of the market actually
buys. That gap is the core of §7-8 below.

---

## 6. Full feature superset — every category the top 10 collectively offer

Built by aggregating what actually showed up across the top 10, not any
single platform's list. This is the working checklist for "expert level" —
keep it in `CLAUDE.md` and update status as phases complete.

### A. Core messaging — **Wasi has this** (established earlier in this project)
- [x] Send text, template, button, list interactive messages
- [x] Receive inbound messages + interactive replies, forwarded to CRM
- [x] Delivery status lifecycle (sent/delivered/read/failed) forwarded
- [x] Idempotent, retry-safe webhook pipeline

### B. Broadcast / campaign engine — **Wasi: missing**
- [ ] Bulk contact import (CSV, with validation/dedup)
- [ ] Segment-based audience targeting (tags, custom attributes, behavior)
- [ ] Scheduled + immediate broadcast sends to segments
- [ ] Send pacing/throttling to protect number quality rating
- [ ] Per-broadcast delivery/read/click/reply analytics
- [ ] A/B testing between template variants

### C. Chatbot / automation flow builder — **Wasi: has a spike, not shipped** (`flow-editor/`)
- [ ] Drag-and-drop visual flow builder (branching logic, not just linear)
- [ ] Trigger types: keyword match, button/list reply, new contact, tag applied
- [ ] Conditional branching on contact attributes
- [ ] Human handoff mid-flow (escalate to live agent)
- [ ] Reusable flow templates by use case (lead qualification, FAQ, booking)

### D. Commerce — **Wasi: missing**
- [ ] WhatsApp Catalog (synced from Shopify/WooCommerce or manually managed)
- [ ] Cart/checkout messages (native WhatsApp cart flow)
- [ ] Payment collection in-chat (WhatsApp Pay / UPI / card links)
- [ ] Order status automation (confirmation → shipped → delivered)

### E. Growth / acquisition — **Wasi: missing**
- [ ] Click-to-WhatsApp ad integration (Meta ads that open a chat, tracked
      back to campaign source)
- [ ] WhatsApp Link/QR/Button generators for websites and offline (trivial
      to build — a URL formatter — cheap, could pull earlier for a quick win)
- [ ] Instagram DM automation (same underlying Meta infrastructure as
      WhatsApp, lower incremental cost than it sounds)

### F. Team / support operations — **Wasi: missing**
- [ ] Shared team inbox — multiple human agents, one number
- [ ] Conversation assignment (manual + rule-based)
- [ ] Internal notes on a conversation (never sent to the customer)
- [ ] Agent performance/response-time analytics
- [ ] Quick replies / canned responses library

### G. AI capabilities — **Wasi: missing, but has the ingredients** (see §8.7)
- [ ] AI-drafted template generator (§2.4)
- [ ] AI copilot suggesting agent replies in the team inbox
- [ ] Autonomous AI agents resolving simple queries end-to-end, handing off
      to a human only when needed

### H. Integrations — **Wasi: has the foundation** (Hub API, MCP server)
- [ ] Native e-commerce integrations (Shopify first)
- [ ] Native payment gateway integration (Razorpay first)
- [ ] No-code connector (Zapier — highest-leverage single item in this plan)
- [ ] CRM-specific native connectors (lower priority than Zapier, which
      already covers this via bridge)

### I. Analytics / reporting — **Wasi: has basics** (admin Statistics view)
- [ ] Template-level performance (open rate, click rate, conversion)
- [ ] Campaign ROI reporting
- [ ] Contact engagement/segmentation analytics

### J. Platform maturity / compliance — **Wasi: partial** (see §8.6)
- [ ] Formal API versioning + deprecation policy
- [ ] OAuth-based third-party app authorization
- [ ] Rate-limit visibility via response headers
- [ ] Security/compliance posture documentation (data handling, retention)
- [ ] Migration tooling from competitor platforms (several competitors
      explicitly build "import from AiSensy/Wati/Interakt" as a growth lever)

---

## 7. What this means — the real gap, stated plainly

Wasi today is **strong on the developer/API layer** (arguably ahead of most
SMB-tier competitors on API design rigor, webhook reliability, and now an
MCP server none of the researched top 10 currently offer) but **has almost
none of the SMB-tier product surface** most of this market's actual revenue
comes from: broadcasting, a real chatbot builder, a shared team inbox, and
commerce features.

**The MCP server is a genuine, current differentiator.** None of the
researched top-10 platforms currently expose their platform as an MCP
server for AI agents to use directly. Worth stating plainly: this is a real
"ahead of the market" position, not just parity — don't let the size of the
gap list in §6 obscure that.

---

## 8. Build plan, by pillar

### 8.1 Template Library — see §2, full detail above
### 8.2 Integrations Marketplace — see §3, full detail above

### 8.3 Broadcast / Campaign Engine (new, highest-priority addition)
Arguably the single biggest gap relative to what this market actually
sells. Build order:
- **Data model**: `contact_lists`, `contact_list_members`, `broadcasts`
  (template_id, target_list_id, scheduled_at, status, pacing_config),
  `broadcast_recipients` (per-contact send status, reusing the same
  delivered/read/failed lifecycle already built for 1:1 messages).
- **CSV import**: validate phone format, dedup against existing contacts,
  reject/report bad rows rather than silently dropping them.
- **Pacing**: send in batches with delay, respecting Meta's rate limits and
  protecting the sending number's quality rating — reuse the rate-limit
  awareness work from §8.6 rather than building parallel logic.
- **Reuse, don't rebuild**: the actual per-message send logic is the exact
  same `send_template_message` path already hardened for the MCP server and
  Hub API — a broadcast is that function called N times with pacing, not
  new sending logic.

### 8.4 Chatbot / Automation Flow Builder
`flow-editor/` already exists as a Vite+React+@xyflow/react spike,
explicitly scoped out of the mobile-responsiveness and other work so far.
This is where it graduates from spike to real feature:
- Confirm current state of `flow-editor/` first — how much is real vs.
  placeholder — before planning further, the same grounding discipline used
  for every other build in this project.
- Flow execution engine: DB tables already referenced elsewhere in this
  project (`automation_flows`, `flow_nodes`, `flow_edges`, `flow_events`,
  `contact_flow_state`) exist per earlier audit work — confirm whether
  they're fully wired to a visual builder or only partially. This
  determines whether this is "finish the builder UI" or "build the whole
  thing," a materially different scope.
- Human handoff: a flow node type that stops automation and routes to the
  team inbox (§8.5) — these two features are coupled, sequence accordingly.

### 8.5 Shared Team Inbox
- **Data model**: `agents` (or reuse the existing admin/client user model if
  one already distinguishes support staff), `conversation_assignments`
  (chat_id, agent_id, assigned_at, status), `internal_notes` (chat_id,
  agent_id, body — never forwarded to the customer or the CRM webhook; this
  distinction should be enforced at the query level, not just the UI).
- **UI**: real-time-feeling inbox (poll or websocket — decide based on what
  this codebase already has infrastructure for; don't introduce a new
  real-time layer speculatively).
- Sequence after the flow builder's handoff node, since they're the same
  feature from two sides.

### 8.6 API Maturity Uplift — grounded in real Salesforce specifics

**Error responses.** Salesforce's real shape, confirmed by direct fetch:
```json
[{ "message": "The requested resource does not exist", "errorCode": "NOT_FOUND" }]
```
Adopt the same core discipline — a stable, machine-readable `errorCode` plus
a human `message` — as a single consistent shape across every Hub API v1
endpoint:
```json
{ "error": { "code": "template_not_approved", "message": "Human-readable, actionable explanation." } }
```
This directly benefits the MCP server (which already needs to map errors to
plain-English tool responses) and any Zapier/native integration consumer —
build once, reuse everywhere.

**Rate-limit / usage headers.** Salesforce's real pattern is a dedicated
response header (`Sforce-Limit-Info`, confirmed via their "Limit Info
Header" doc) returned on every API response — distinct from a 429 error — so
well-behaved clients can self-throttle before hitting a limit. Build the
Wasi equivalent: `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset`, on every Hub API v1 response.

**Deprecation signaling.** Salesforce's real "Warning Header" fires
specifically when a client uses a deprecated API version. Adopt a concrete
mechanism, not just a docs page: an `X-Wasi-API-Deprecation` response header
carrying the sunset date, returned automatically once an endpoint/field is
marked deprecated.

**API versioning policy.** Document explicitly: adding an optional field is
non-breaking; removing a field or changing its type/meaning is breaking and
requires the deprecation-header mechanism above plus a minimum notice window
(e.g. 90 days) before removal. Write this once real external consumers
(Zapier, native integrations) exist and depend on shape stability — sequence
this near the end of the master build order (§9.1), not at the start.

**OAuth / Connected Apps.** Salesforce's real model, confirmed by direct
fetch: a registered "connected app" (or their newer "external client app")
requests access via an OAuth 2.0 flow, gets short-lived tokens, and a
resource server validates those tokens per-request — three actors (client
app, authorizing server, resource server), not two. Build Wasi's equivalent:
**register Zapier (and any future third-party partner) as its own
"connected app" record**, distinct from a raw client API key, issuing
short-lived tokens that map back to an underlying API key server-side.
Build this once, reuse for Zapier and the MCP server's future remote
transport.

### 8.7 AI Capabilities
Sequence this last among the new pillars — it's the least differentiated
relative to the market (every top-10 competitor either has or is building
this) and the most dependent on other pillars existing first:
- **AI Template Generator** (§2.4) — no dependency, buildable anytime after
  the static library ships.
- **AI Copilot in the team inbox** — depends on §8.5 existing first;
  suggests a reply to a human agent, doesn't send autonomously.
- **Autonomous AI agent** — depends on §8.4's flow engine existing first (an
  AI agent needs the same handoff/escalation infrastructure a rule-based
  flow needs); highest risk/complexity item in this entire plan, build
  last, and treat the MCP server's own tool-calling infrastructure as the
  natural foundation to extend rather than building a separate AI system.

### 8.8 Analytics / ROI Reporting
Extends the admin Statistics view already built (`GET /api/admin/stats`,
Chart.js). Add template-level performance and campaign ROI once the
Template Library (§2) and Broadcast Engine (§8.3) exist to generate the
underlying data — don't build this before those two, there's nothing
meaningful to report on yet.

---

## 9. Master build order — everything, sequenced

### 9.1 Full sequence
1. **Living documentation system** (§4) — first, so everything after this
   point is tracked from day one.
2. **API maturity: error shape + rate-limit headers** (§8.6, the cheap
   parts) — benefits everything built after it, especially the MCP server
   already live.
3. **Template Library v1** (§2) — high visible value, no dependencies.
4. **Broadcast/Campaign Engine** (§8.3) — the single biggest gap versus
   what this market actually sells; reuses existing send logic.
5. **Integrations Marketplace, Zapier first** (§3, Tier 2) — highest
   leverage-per-effort item in the whole plan.
6. **OAuth "Connected Apps" layer** (§8.6) — needed before Zapier goes from
   private/beta to real distribution, and before any future third-party
   partner.
7. **Chatbot/Automation Flow Builder** (§8.4) — graduate `flow-editor/`
   from spike to real, after confirming its actual current state.
8. **Shared Team Inbox** (§8.5) — sequenced with #7, human-handoff couples
   them.
9. **Integrations Marketplace, Tier 1 native** (§3, Shopify then Razorpay).
10. **Commerce features** (Catalog, in-chat payments) — depends on Tier 1
    e-commerce integration existing first.
11. **Growth features** (Click-to-WhatsApp ads, Link/QR generators — the
    generators are cheap and could be pulled earlier for a quick, low-risk
    win).
12. **Analytics/ROI reporting extensions** (§8.8) — after Template Library +
    Broadcast Engine exist to generate real data.
13. **AI capabilities** (§8.7) — last, most dependent on everything above.
14. **API versioning policy formalization** (§8.6) — once real external
    consumers depend on shape stability.

### 9.2 Prompt template to reuse for every phase above
```
Build [PHASE NAME] end to end, without pausing for approval at each step.

PHASE 0 — ground yourself in the real current code (not this plan document's 
summary of it), ask every question you need in one batch, then proceed 
uninterrupted once I answer.

PHASE 1 — build, with real DB test client + Meta-boundary-only faking for 
integration tests, per this project's established standard. Show before/after 
proof for any bug found along the way.

PHASE 2 — verification: real test output, not "should work."

PHASE 3 — update CLAUDE.md's feature inventory table (status, location, docs 
link) and any affected section of crm-integration-guide.md / the in-app API 
Guide. Show me the CLAUDE.md diff as part of your completion report — a build 
without this is not complete.

Report back only when fully done: what was built, real test evidence, 
deviations, and the CLAUDE.md diff.
```

---

## 10. Expert self-verification checklist

- [ ] Does every new DB migration remain additive/nullable, confirmed
      against the shared dev/prod DB before running?
- [ ] Does every new endpoint follow the consistent error-shape from §8.6?
- [ ] Does every new endpoint that could return a secret/credential get
      checked against the exact leak pattern already found and fixed twice
      in this project (a `returning *`/spread that forgets a sensitive field)?
- [ ] Is there real (not hand-waved) test coverage, with before/after proof
      for any bug fixed along the way?
- [ ] Does the Template Library's content avoid overclaiming ("pre-vetted,"
      not "guaranteed approved")?
- [ ] Does the Zapier integration use the OAuth layer (§8.6), not a raw
      static key handed to a third party?
- [ ] Is `CLAUDE.md` updated, and does its feature-inventory table's status
      column reflect verified reality, not aspiration?
- [ ] Would a new developer (or a fresh Claude Code session with no prior
      context) be able to read `CLAUDE.md` alone and understand what
      exists, what's in progress, and what's deliberately deferred?
- [ ] Does every §6 checklist item have a current, honest Have/Partial/
      Missing status, tracked in `CLAUDE.md` going forward?
- [ ] Was no pillar built before its stated dependency (e.g. Team Inbox
      before the flow builder's handoff node, Analytics before the
      Broadcast Engine exists to generate data)?
- [ ] Was the OAuth "Connected Apps" layer built once and reused for both
      Zapier and any future MCP remote transport, not duplicated?
- [ ] Does every new send-capable feature (broadcasts, flows) reuse the
      existing, already-hardened send logic rather than reimplementing
      message-sending?
- [ ] Was the AI capabilities pillar sequenced last, not first, regardless
      of how tempting it is to lead with?
- [ ] Does the plan distinguish "matching the market" from "copying a
      competitor's actual content/copy" everywhere it applies?

If any box is unchecked, the phase isn't done yet — regardless of how much
code has been written.
