# Custom forms (form builder)

Owner request 2026-11-24: "the form UI is a bit complicated, don't we create
a custom form?". Reverses the 2026-11-23 decision "Flows = fixed set"
(recorded in MEMORY.md).

## Purpose
Forms only offered fixed question sets (lead / booking / survey /
onboarding): you could reword a question but not add, remove or reorder
questions, or pick their type. Businesses need their own questions.

## What the user gets
- New form: start from **Blank form** or a template (Lead, Booking,
  Feedback, Business onboarding). A template just fills in the questions;
  everything stays editable. "Booking with live slots" keeps its own
  availability editor (it is driven by Wasi's endpoint, not free questions).
- Each question: type, question text, choices (choice types only),
  Required, move up/down, delete. "+ Add question" (20 at most).
- Preview sits beside the editor on wide screens (stacked on phones).

## Question types (Meta components reference, checked 2026-11-24)
| Type | Component | Label max | Choices |
|---|---|---|---|
| Short answer | TextInput text | 20 | - |
| Long answer | TextArea | 20 | - |
| Email / Phone number / Number | TextInput email / phone / number | 20 | - |
| Date | DatePicker | 40 | - |
| Dropdown | Dropdown | 20 | 1-200, 30 chars each |
| Single choice | RadioButtonsGroup | 30 | 1-20, 30 chars each |
| Multiple choice | CheckboxGroup | 30 | 1-20, 30 chars each |
Meta: 50 components per screen; Wasi caps a form at 20 questions.
Meta does not document the submitted value shape for CheckboxGroup, so
answer parsing accepts an option id or an array of ids.

## Architecture
- `whatsapp_flows.config.fields` becomes an ordered array
  `[{key, type, label, required, options?}]`. Existing rows keep the old
  object shape; `whatsappFlowTemplates.fieldList(config, kind)` reads both,
  and every reader (Flow JSON, answer text, CSV, contact-field mapping, UI)
  goes through it. Saving a form writes the array shape.
- Keys: kept when valid and unique (`^[a-z][a-z0-9_]{0,29}$`), otherwise
  the server assigns `q1`, `q2`... Contact-field mapping and stored
  responses are keyed by them, so existing keys never change on edit.
- API still accepts the old `fields: {key: {label, options, required}}`
  edits (Hub/legacy callers, existing tests).
- New kind `custom` (Meta category OTHER, screen FORM), migration 108.
- `GET /api/whatsapp-flows/question-types` gives the UI the types and limits
  from the server's single table.

## Impact map
`utils/whatsappFlowTemplates.js` (normalize, build, describe), 
`routes/whatsappFlows.js` (kind enum, attribute-map, CSV, question-types),
`metaWebhook.js` (uses describeResponse, unchanged), send-form paths
(unchanged: screen per kind), `app.js`/`index.html`/`index.css` Forms drawer
and contact-field drawer.

## Edge cases
- No questions, over 20, unknown type, empty or too-long label, choices
  missing / too many / duplicate / too long: 400 with every reason, nothing
  sent to Meta.
- Changing a draft's choices re-maps old responses by position (same as
  before).
- Published forms still can't be edited on WhatsApp: Duplicate.

## Acceptance criteria
1. A blank form with one question of each type builds valid Flow JSON with
   the right component, input-type and options.
2. Old object-shaped configs still build, describe and export unchanged.
3. Invalid input returns every reason; nothing reaches Meta.
4. Keys are kept on edit; missing/duplicate keys are assigned.
5. Multiple-choice answers (id or array of ids) read as option text.
6. CSV and contact-field mapping use the form's own questions.
7. UI: add, retype, reorder and delete questions; the preview follows; a
   template prefill is editable; saving sends the array to the server.
