# Template category changed by Meta

## Purpose
Clients submit a template as Utility and Meta approves it as Marketing (Meta's
rule since April 2025), or recategorises an approved template later. Wasi
overwrote `category` on sync with no record, so nothing told the client their
template now costs Marketing rates and only goes to opted-in contacts.

## Architecture
- Migration 109: `message_templates.previous_category`, `category_changed_at`,
  `upcoming_category`, `upcoming_category_at` (table-level grant, no grant change).
- Create (CRM `POST /api/templates`, Hub `POST /api/v1/templates`): Meta's create
  response carries `category`; if it differs, `applyMetaCategory` stores it and
  the response gets a `warnings` entry.
- Sync: `updateFromMetaSync` moves the old category to `previous_category` when
  it changes. Meta's `previous_category` (list field) backfills changes Wasi
  already overwrote; `correct_category` becomes `upcoming_category`.
  `listTemplates` retries without those two fields if Meta rejects them.
- Webhook `template_category_update`: advance notice (`correct_category`,
  `category_update_timestamp`) sets `upcoming_category`; completed change
  (`previous_category`, `new_category`) applies it. Matched by template id,
  then name + language (`en-US` -> `en_US`). Audit-logged.
- UI: amber note on the template card, "(was Utility)" in the card footer,
  "Changed by Meta" in the category filter, a dialog (not a toast) after create.

## Impact map
- `messageTemplatesRepo` (create path unchanged; sync functions extended).
- `templateSyncService`, `metaClient.listTemplates` (extra fields + fallback).
- `metaWebhook.js` (new handler; not forwarded: `wabas.forward_events` CHECK
  has no such event).
- Consent gate (`messagingService`) already reads `category`, so a recategorised
  template is correctly treated as Marketing for opt-in.

## Edge cases
- Meta rejects the extra list fields on the pinned Graph version: retried without.
- Webhook for an unknown template: audit-logged, 200, no change.
- Repeat sync with no change: the original change time is kept.
- `previous_category` meaning on the list object is undocumented by Meta;
  only used when it differs from the current category.

## Acceptance criteria
AC1-AC8 in `server/test/templateCategoryChange.test.js`.

## Not done / owner action
- `template_category_update` is not in the app's webhook subscription list
  (App Dashboard > WhatsApp > Configuration). Until it is, changes show up
  after a sync or at creation time only.
