# WhatsApp Flows (native interactive forms)

## Status (2026-11-23)
Built and tested against a faked Meta API (see TESTING.md). **Not yet tried
against the real Meta API**: this machine cannot decrypt the demo account's
WhatsApp token (CLAUDE.md, SERVER_SECRET Known Gap), and deploys are paused
while the repo is public. First live check, on the demo account to
9092766740 only (owner-approved): create a draft, send it in draft mode,
submit it, and confirm the `nfm_reply` shape.

As built (scope answered by the owner: fixed set, not a designer):
- Three types (lead, booking, survey) in `server/src/utils/whatsappFlowTemplates.js`.
  Only components Meta documents: TextInput, Dropdown, DatePicker and
  Footer. Flow JSON 7.3, kept in one constant because Meta freezes old
  versions.
- Tables `whatsapp_flows` and `whatsapp_flow_responses` (migration 095).
  They are deliberately not named `flows`: `automation_flows` is
  unrelated.
- Lifecycle: create as a draft on Meta (JSON inline) -> edit (drafts only,
  re-upload `flow.json`) -> publish -> retire (Meta "deprecate").
  Published forms can't be edited on Meta, so the UI offers Duplicate.
  Delete: drafts are deleted on Meta first; published forms must be retired
  first; retired forms are deleted locally only.
- Sending: the chat menu's "Send form" calls `POST /api/chats/:id/forms`.
  It lives in `routes/chats.js` because a person sending a form is a human
  reply, and `markAgentReplyNonFatal` may only be called there. Only inside
  the 24h window. Drafts go out with `mode: draft` (Meta shows a draft
  banner). A failed form is never retried as plain text
  (`cannot_retry_form`).
- Receiving: `nfm_reply` -> a readable chat message plus a response row,
  idempotent on the Meta message id. Meta's reply has no flow id, so ours
  rides in `flow_token` (`wasi_flow:<id>`). Dropdown answers come back as
  `opt_N` and are mapped to their text. Field order comes from the form
  type, because jsonb reorders keys.

Not built yet (follow-ups):
- A FLOW button inside a template, for sending outside the 24h window.
- Mapping answers into contact attributes.
- Exporting responses as CSV.
- Data-endpoint flows.

Meta requirements: publishing needs a Meta-verified business with good
message quality. Whether Flows work on Coexistence numbers is not
confirmed in Meta's docs.

## Purpose
Part of the CRM-wide messaging audit (2026-11-16), scoped to templates/
messaging after the carousel-template gap was found. AiSensy, WATI, and
Interakt all support sending a **Flow** — a multi-screen native form
(text inputs, dropdowns, checkboxes) rendered inside WhatsApp itself, used
for lead-qualification forms, appointment booking, surveys, order forms.
Confirmed by grep: zero `flows_action`/`flow_token`/`flow_id`/Flow-JSON
references anywhere in `metaClient.js` or the flow-engine
(`flowEngine.js`'s own "flow" is this app's *automation* flow builder — an
unrelated, already-built feature, confirmed distinct by reading it). This
app can send template messages and two interactive shapes (button, list)
but not a WhatsApp Flow in either direction — can't send one, can't
receive/store its completion response.

## Scope decision (confirming before implementing)
Meta Flows have two creation paths: (1) author the Flow's JSON (screens,
fields, validation, navigation) via Meta's Flow Builder /
`/{waba_id}/flows` API, or (2) use one of Meta's few **prebuilt flow
templates** (e.g. "Appointment booking," "Sign up"). Building a full
drag-and-drop Flow-JSON screen editor inside this CRM is a large
second project on its own (closer in size to the automation Flow Builder
that already exists than to a template-creation form).
**Proposing to scope this feature to**: (a) create/manage Flows via a
small number of this app's own authored JSON templates for the most
common use cases (lead form, appointment booking, feedback survey) with
field labels editable per-client, not a general-purpose screen designer;
(b) send a Flow inside a template button or as a standalone interactive
message; (c) receive and store the completed Flow response
(`nfm_reply` in the inbound webhook) against the contact.
**Needs your confirmation**: is a from-scratch visual Flow-JSON screen
designer actually wanted later, or is the small fixed-template-set scope
above sufficient for now? Everything below assumes the smaller scope.

## Architecture
**Flow lifecycle with Meta** (new, nothing today does any of this):
- Create: `POST /{waba_id}/flows` with `{name, categories}`, then
  `POST /{flow_id}/assets` to upload the Flow JSON, matching the
  create-upload-publish three-step pattern Meta also uses for media
  headers (`metaClient.createUploadSession`/`uploadFileBytes` is a
  close precedent, though Flows use a distinct endpoint shape).
- Publish: `POST /{flow_id}/publish` — required before a Flow can be sent;
  mirrors this app's existing template `status: 'pending' -> 'approved'`
  async pattern, except Flow publishing is synchronous (no webhook wait).
- A new `flows` table: `id, client_id, meta_flow_id, name, status
  ('draft'|'published'|'deprecated'), flow_json jsonb, created_at` —
  parallel to `message_templates`, not a column bolted onto it (a Flow is
  sendable standalone, not only as a template attachment).

**Send (`metaClient.js`)**
- New `sendFlowMessage(phoneNumberId, accessToken, toPhone, {flowId,
  flowToken, flowCta, bodyText, screenId, initialData})` mirroring
  `sendInteractiveMessage`'s exact shape, with `interactive.type: 'flow'`
  and `interactive.action.parameters: {flow_message_version: '3',
  flow_token, flow_id, flow_cta, flow_action: 'navigate', flow_action_payload:
  {screen, data}}`.
- Also sendable **inside a template button** (`buttons: [{type: 'FLOW',
  text, flow_id, navigate_screen}]`) — `templateButtonSchema` in
  `validate.js` grows a `FLOW` button type alongside existing
  `URL`/`PHONE_NUMBER`/`QUICK_REPLY`.
- `sendChatMessage` (`messagingService.js`) grows a `type: 'flow'` case next
  to its existing `'text'`/`'interactive'`/`'template'` branch — same
  24h-session-window rule as the other two non-template types (a Flow
  isn't inherently pre-approved like a template unless sent via a
  template's FLOW button).

**Receive (`routes/metaWebhook.js`)**
- Inbound webhook delivers the completed Flow as
  `message.interactive.nfm_reply.response_json` (a string of the
  screen-submitted field values). New handling alongside the existing
  `button_reply`/`list_reply` branches (if any exist today in the webhook
  router — confirmed `interactive.button_reply.id`/`list_reply.id` are
  already consumed for automation-flow branching per
  `flowEngine.js`'s comments; `nfm_reply` is the missing third case).
- Store the parsed response as a `chat_messages` row (so it shows in the
  chat transcript, same as any inbound message) **and** optionally write
  matching fields into `contact_attribute_values` when a Flow's field
  names are mapped to existing contact attributes — this second part is
  what makes a lead-qualification Flow actually useful, not just a
  transcript curiosity.

## Impact map
- `server/src/db/migrations/0NN_flows.js` (new) — `flows` table; a `FLOW`
  value added to the template button-type check constraint.
- `server/src/utils/metaClient.js` — `sendFlowMessage`; Flow create/upload/
  publish helpers; `buildUtilityMarketingPayload`'s button-building already
  loops generically over `buttons` (confirmed, line ~670-679) — a `FLOW`
  button needs its own branch there (different required fields than
  URL/PHONE_NUMBER/QUICK_REPLY).
- `server/src/utils/validate.js` — `templateButtonSchema` (`FLOW` type),
  new `flowCreateSchema`.
- `server/src/services/messagingService.js` — new `type: 'flow'` send case.
- `server/src/routes/metaWebhook.js` — `nfm_reply` handling.
- `server/src/routes/flows.js` (new route file) + `app.js`/`index.html` —
  a "Flows" management screen (list, create-from-template, publish),
  separate from the existing Automation Flow Builder screen — **do not
  merge these in the UI**, they are unrelated concepts that happen to
  share the English word "flow"; naming this screen "Forms" in the UI
  (even though it's "Flows" in Meta's own API) may be worth considering to
  avoid confusing it with the automation Flow Builder already in the nav.
- **Does not touch**: the existing automation Flow Builder
  (`flowEngine.js`, `automationFlowCreateSchema`, its nodes/edges tables) —
  confirmed fully separate concern, zero shared tables or code paths.

## Edge cases and failure modes
- A Flow referenced by a template's `FLOW` button gets deprecated/deleted
  in Meta after the template is already approved → send fails with a Meta
  error; surfaced as today's existing `describeMetaError`-wrapped 502, not
  a new error class (no local state to protect — Meta is the source of
  truth for Flow validity at send time).
- `nfm_reply.response_json` arrives malformed or for a Flow this app
  doesn't recognize (e.g. authored directly in Meta's own Flow Builder,
  never synced here) → store the raw inbound message regardless (never
  drop an inbound message because its structured parse failed), skip the
  contact-attribute-mapping step silently in that case only.
- A client sends a Flow message outside the 24h session window with no
  approved template wrapping it → same `session_window_closed` rejection
  this app already gives for bare interactive/text sends.

## Acceptance criteria
1. A client can create a Flow from one of this app's authored templates
   (e.g. "Lead qualification"), publish it, and it appears with a real
   `meta_flow_id`.
2. A published Flow can be sent standalone inside an open session, and via
   a template's `FLOW` button for a session-independent send.
3. A completed Flow response lands as a readable chat message and (when
   field mapping is configured) updates the contact's attribute values.
4. Existing template button types (URL/PHONE_NUMBER/QUICK_REPLY) and the
   existing automation Flow Builder are provably unaffected — their test
   suites (`templateEdit`, `automationFlow*` if present) pass unmodified.
