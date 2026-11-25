# Marketing consent: account attestation + opt-in via the Hub API

Owner decision 2026-11-25 (options B and C).

## Purpose
- Marketing template sends required every contact to be `opted_in`. In production about 4,350 real contacts were `unknown` and about 9 were `opted_in`, so Marketing was blocked for almost every client, including Hub API / n8n sends.
- Meta puts the opt-in duty on the business and enforces it afterwards, through quality rating and limits, not at send time. Other providers (AiSensy, Wati, Interakt) let the business confirm consent once and block only opted-out contacts.
- B: a client confirms once, for the whole account, that it collects opt-in. After that, `unknown` contacts can receive Marketing. `opted_out` contacts are always blocked.
- C: the Hub API can record opt-in or opt-out, so n8n or a CRM can pass on consent it collected itself.

## Architecture
- **Table `marketing_consent_attestations`** (migration 111, append-only): `client_id`, `event` (`attested` | `withdrawn`), `statement_version`, `statement_text` (verbatim), `actor_type` (`owner` | `team_member`), `actor_id`, `created_at`. The current state is the latest row. Tenant RLS, plus `select, insert` for `wasi_app` (no update or delete).
- **Repo `marketingConsentRepo`:** `getCurrent(db, clientId)`, `isAttested(db, clientId)`, `record(db, clientId, {...})`.
- **Wording:** `ACCOUNT_CONSENT_STATEMENT` + `ACCOUNT_CONSENT_VERSION` in `utils/consentStatement.js`. Draft text, pending legal review.
- **Send rule (`messagingService.assertConsentForTemplate`, the one choke point):** applies to Marketing templates (and an unknown category, which fails closed):
  - `opted_out` → `contact_opted_out` (always)
  - `opted_in` → allowed
  - `unknown` / no contact → allowed if attested, else `consent_required`
  - Utility and Authentication are unchanged.
- **Broadcast runner:** skips (does not fail) on both `consent_required` and `contact_opted_out`. `routes/broadcasts.js`'s `consentWarning` counts what will actually be skipped.
- **Client routes `/api/marketing-consent`:**
  - `GET` (any role): state, statement, contact counts.
  - `POST {attested: boolean}`: Owner/Admin only. Writes an `audit_log` row.
- **Hub API:**
  - `POST /api/v1/contacts/consent` `{phone, status: opted_in|opted_out, method?, note?}`. `method` is required for `opted_in`.
  - `POST /api/v1/messages` accepts an optional `optIn: {method, note?}`, recorded before the send.
  - Both go through `consentRepo.recordEvent` with source `hub_api`, `actor_type` `api_key`, `actor_id` = the API key id, and evidence `{statement, method, note, source}`. Opt-out stays sticky: an opt-in for an opted-out contact → 409 `contact_opted_out`, and no send.
- **UI:** a Settings > Compliance > "Marketing consent" section. It shows the statement, a checkbox (Owner/Admin), who confirmed and when, and contact counts.

## Impact map
- `messagingService.js`: every template sender (inbox, Hub API, flows, WooCommerce, broadcasts). Risk: an opted-out contact getting Marketing, which tests cover.
- `broadcastRunner.js`: the skip path for the new code.
- `routes/broadcasts.js`: the warning text and count.
- `routes/apiV1Messages.js`, `routes/apiV1Contacts.js`, `utils/validate.js`: new optional field and new route; existing requests are unchanged.
- `consentRepo.recordEvent`: reused unchanged; the new `actor_type` value `api_key` has no CHECK constraint (migration 077).
- `metaWebhook.js` forwarding: untouched (no `messages` column added).
- `index.html` / `app.js`: new Settings section.
- Docs: `crm-integration-guide.md`, `CLAUDE.md`.

## Edge cases
- An attestation withdrawn later: `unknown` contacts are blocked again on the next send. Broadcast recipients still queued are skipped at send time.
- An Agent or Manager tries to attest → 403. Owner/Admin only, because it binds the business legally (same rule as AI consent).
- A request without `attested` as a boolean → 400.
- Hub API opt-in with a bad or missing `method` → 400 (Zod → `validation_error`).
- Hub API opt-in or opt-out for a new phone: the contact is created (same `upsertByPhone` as the send path).
- `optIn` on a non-Marketing send: still recorded (the caller asserted it); harmless.
- Concurrency: `recordEvent` locks the contact row, so a racing STOP wins correctly.
- Withdrawing never changes contacts' own `opt_in_status`.

## Acceptance criteria
1. Without an attestation, a Marketing send to an `unknown` contact → `consent_required` (unchanged).
2. With an attestation, the same send goes through.
3. A Marketing send to an `opted_out` contact → `contact_opted_out`, attested or not.
4. Utility sends are unaffected in every state.
5. Only Owner/Admin can attest or withdraw. Each change writes an attestation row with the verbatim statement, plus an audit row.
6. `POST /api/v1/contacts/consent` records opt-in/out with source `hub_api`; an opt-in for an opted-out contact → 409 `contact_opted_out`.
7. `POST /api/v1/messages` with `optIn` records the opt-in, then sends; for an opted-out contact → 409 `contact_opted_out`, and no message row.
8. The broadcast runner skips (does not fail) `contact_opted_out`.
