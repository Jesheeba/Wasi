# wasi-crm-server

Backend for the Wasi CRM tech-provider platform: real Postgres-backed multi-tenant data,
client + admin JWT auth, Meta Embedded Signup provisioning, a real WhatsApp Cloud API
message gateway (send/receive/status), a campaign fan-out engine, keyword automation,
Razorpay billing with invoices, and an admin panel API. See
`../meta-tech-provider-platform-spec.md` for the original platform plan and
`../GO_LIVE_CHECKLIST.md` for what's left on the Meta/Razorpay account side before
going live with real clients.

## Setup

```bash
cd server
npm install
cp .env.example .env      # adjust DATABASE_URL if port 5432 is taken
npm run db:up               # starts Postgres (+ Adminer on :8080) via Docker
npm run db:migrate
npm run db:seed
npm run dev                 # http://localhost:4000
```

Seeded demo logins (printed by `db:seed`): client `demo@wasi.local` / `demo12345`,
admin `admin@wasi.local` / `admin12345`.

### No Docker?

Skip `npm run db:up` and run a portable Postgres with no admin rights required:

```bash
npx node scripts/dev-postgres.js   # leave running in its own terminal
```

Uses the `embedded-postgres` dev dependency, data under `server/.pgdata` (gitignored),
same `crm`/`crm_dev_pw`/`crm_dev` credentials `.env.example` points at.

### Deploying against a hosted Postgres (Supabase, etc.)

Use the connection **pooler** string, not a direct `db.<ref>.supabase.co` host — that
host is IPv6-only and fails to resolve on most networks/hosts. See `../DEPLOY.md` for
the exact gotcha and fix (`PGSSLMODE=no-verify`, no `?sslmode=` query param).

## Auth

Real JWT auth for both actor types — no dev header stub. `POST /api/auth/register` /
`/login` (clients), `POST /api/admin/auth/login` (admins, seeded via `db:seed` or
`POST /api/admin/admin-users` by a `super_admin`). Forgot/reset password and email
verification are implemented (`server/src/routes/auth.js`,
`server/src/utils/emailService.js`) — without `RESEND_API_KEY` configured, reset/verify
links are logged to the console instead of emailed, so the flow is still testable in dev.

## API surface (grouped — see `server/src/app.js` for the exact mount points)

- `GET /health`
- **Auth**: `/api/auth/*` (client), `/api/admin/auth/*` (admin) — register, login, me,
  forgot/reset password, email verification
- **Tenant CRM data** (all `requireClientAuth`): `/api/contacts`, `/api/chats` (+
  `/:id/messages`, `/:id/messages/:messageId/retry`), `/api/tags`, `/api/broadcasts`,
  `/api/automation-rules`, `/api/templates`, `/api/support-tickets`, `/api/analytics/*`,
  `/api/team-members`, `/api/contact-attributes`, `/api/payment-links`, `/api/wallet`,
  `/api/client-webhook`
- **Onboarding / WhatsApp**: `/api/onboarding/config`, `/api/onboarding/whatsapp/status`,
  `/api/onboarding/whatsapp/connect` (Embedded Signup token exchange + provisioning)
- **Billing**: `/api/billing/plans`, `/subscription`, `/invoices`, `/checkout`, `/cancel`
- **Public webhooks** (no client JWT — signature-verified instead):
  `/webhooks/meta` (messages/statuses/template-status/account-update),
  `/webhooks/meta/data-deletion` (+ `/status/:code`), `/webhooks/razorpay`
- **Admin-only** (`requireAdminAuth`): `/api/clients`, `/api/admin/*` (overview,
  onboarding-queue, wabas, client detail + retry-provisioning, audit-log, admin-users,
  billing/overview, templates review, tickets, settings, data-deletion-requests)

## Background workers

`server/src/services/broadcastRunner.js` starts with the server (`src/index.js`) — polls
every 5s, fans out campaign sends via the Cloud API with a bounded concurrency (5) and
durable, resumable progress (Postgres row claiming via `FOR UPDATE SKIP LOCKED`, not
in-memory state). No Redis/queue broker needed at this scale.

## Useful commands

```bash
docker compose exec postgres psql -U crm -d crm_dev   # DB shell (no local psql needed)
npm run db:reset                                       # drop, re-migrate, re-seed
```
