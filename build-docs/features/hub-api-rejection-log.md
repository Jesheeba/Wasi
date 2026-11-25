# Hub API refused-request log

Owner request 2026-11-25 ("okay fix the issue").

## Purpose
- Only sends that reached Meta left a trace (a `messages` row). Anything Wasi
  refused first (invalid_phone, consent_required, params_mismatch,
  template_not_approved, validation_failed, rate_limited...) left nothing, so
  "why did n8n fail?" could not be answered.

## Architecture
- Table `api_rejections` (migration 112): client, API key (SET NULL), method,
  path, status, code, message (500 chars), time. Platform-internal, no
  `wasi_app` grant.
- `utils/apiError.js` `sendApiError` records every refusal of a request that
  has `req.clientId` + `req.apiKeyId` (set by `requireApiKey`). Fire-and-forget,
  never throws. A bad key (no client) is not logged.
- Admin Client Detail > Activity: "Refused Hub API Requests" card (last 30).
- `alertRunner` tick purges rows older than 30 days.

## Edge cases
- A DB error while logging is caught and logged to console; the API response is unchanged.
- Bursts: one row per refused request (a 150-row n8n run that fails = 150 rows,
  purged after 30 days).

## Acceptance criteria
3. Each refusal of an API-key request is stored with code, key and path; a bad key is not.
4. Admin Client Detail returns them.
5. Rows older than 30 days are purged.
