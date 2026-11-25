# Hub API template parameter check

Owner request 2026-11-25 ("okay fix the issue").

## Purpose
- LEADERS CONNECT's n8n sent `params: {hi}` to `mirai_2026_early_bird_reminder`,
  which has no variables. Wasi forwarded it; Meta rejected all 151 with the
  cryptic `(#132000) Number of parameters does not match`.

## Architecture
- `utils/templateParams.js` `checkSendParams(name, body, params)`: compares the
  `{{...}}` names in the stored template body with the `params` keys. Reports
  "has no parameters - remove params", missing keys, keys not in the template,
  and empty values. Positional (`{{1}}`) templates match by number.
- `POST /api/v1/messages` (template sends, not Authentication) returns 400
  `params_mismatch` with that message before any message row or Meta call.
  Skipped when no body is stored locally.

## Impact map
- Hub API callers (n8n, Zapier, MCP): a request Meta would have rejected now
  fails earlier with a clear message. Nothing that used to work is refused:
  Meta rejects every mismatch too.
- Header-text parameters are not part of the Hub API send and are not checked.
- `apiV1.test.js` tests 6-8 sent a `{{customer_name}}` template without params
  (unsendable at Meta); they now send the parameter.

## Acceptance criteria
1. Params sent to a template with no variables -> 400 `params_mismatch`, no message row.
2. Missing, extra or empty params -> `params_mismatch`; exact params pass.
