# Template approval guard

## Purpose
Reported: "Meta didn't approve the template but n8n can use it". Nothing in
Wasi checked approval: every sender looked a template up by name only and
handed it to Meta. Checked in production (2026-11-24, read-only): no pending
template was actually delivered (Meta refuses them), but the request was
accepted, a message row created, and the failure only showed up later.

## Rule
- Sendable: `status = 'approved'`, or `pending`/`in_appeal` with `approved_at`
  set (an approved template that was edited - Meta keeps sending the old
  version while re-reviewing).
- Anything else is refused pre-flight with `template_not_approved` (409 on the
  Hub API), before any message row or Meta call.
- Before refusing, one live `GET /{meta_template_id}?fields=status`; if Meta
  now says approved, the local row is updated and the send proceeds.

## Architecture
- Migration 110: `message_templates.approved_at`, set by a trigger whenever a
  row becomes approved (covers sync, webhook, admin approve, create). Backfill:
  approved rows and any template ever sent successfully.
- `messagingService.assertTemplateSendable` (all senders funnel through
  `sendChatMessage`); `isTemplateSendable` reused by `POST /api/broadcasts`.
- `messageTemplatesRepo.findByNameAndClient` prefers approved rows, so a newer
  pending language variant can't shadow the approved one.
- Create (`routes/templates.js`, `apiV1Templates.js`) stores Meta's returned
  status instead of always `pending`.

## Impact map
- Hub API, chat inbox, flows, WooCommerce rules, broadcasts creation.
- Not covered: `alertNotifier`/`clientNotifier` (Wasi's own templates);
  broadcastRunner per-recipient sends (checked at creation).

## Edge cases
- No local row: unchanged (Hub API already 404s).
- Meta lookup fails: refuses on local status, logs the error.
- Template paused after a broadcast started: Meta rejects per recipient.

## Acceptance criteria
AC1-AC7 in `server/test/templateApprovalGuard.test.js`.
