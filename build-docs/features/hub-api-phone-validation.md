# Hub API phone validation

Owner request 2026-11-25 ("yes do it").

## Purpose
- The Hub API stored any text sent as `to` or `phone`. Production had contacts
  with phone `undefined` (LEADERS CONNECT's n8n read a field that didn't
  exist), `not-a-number`, `x`, and a real Fortune Innovatives number with an
  invisible U+202C on the end, which Meta rejects on every send.

## Architecture
- `utils/csvContacts.js` `normalizePhone`: the CSV import's existing cleanup
  (spaces, `-`, `()`, `.`, leading `+`), now also stripping invisible Unicode
  format characters (`\p{Cf}`). `isValidPhone`: 10-15 digits (unchanged).
  New `invalidPhoneMessage(field, raw)`.
- `POST /api/v1/messages` (`to`) and `POST /api/v1/contacts/consent`
  (`phone`): normalize, then refuse with 400 `invalid_phone` before any
  contact, chat or message row exists. `GET /api/v1/contacts?phone=`
  normalizes the lookup.
- No country code is added automatically (clients are not all Indian). A
  10-digit number still passes; the docs say to include the country code.

## Impact map
- CSV import (`routes/contacts.js`, `routes/contactLists.js`): same
  normalizer, so invisible characters are now stripped there too (stricter is
  safe: those numbers could never be sent to).
- Hub API callers (n8n, Zapier, MCP): a request with a bad number now gets 400
  instead of a junk contact plus a Meta failure.
- Existing junk contacts are not changed (separate cleanup, needs the owner's OK).

## Edge cases
- `undefined`, `null`, empty, whitespace → 400, with a hint that the
  automation's field name is probably wrong.
- Formatted numbers (`+91 99406-58027`) and invisible characters → cleaned
  and stored digits-only.

## Acceptance criteria
1. Invalid `to` / `phone` → 400 `invalid_phone`, no contact created.
2. A formatted number with invisible characters is stored digits-only.
3. A lookup by a formatted number finds the stored contact.
