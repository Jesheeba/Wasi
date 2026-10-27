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

Seeded demo logins: `demo@wasi.local` and `admin@wasi.local`. Against a local database `db:seed` uses
fixed dev-only passwords; against any other database it refuses to run unless
`SEED_ADMIN_PASSWORD` and `SEED_DEMO_PASSWORD` are set (never commit real values).
To set or rotate either password directly, use `node scripts/set-password.js
admin admin@wasi.local` (or `client demo@wasi.local`) — prompts for the new
password with hidden input, never a CLI arg/env var/printed value, and
revokes every existing session for that account.

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

### Running tests

This project has no separate dev database — `DATABASE_URL` is the same Supabase
instance as production — so any test that actually touches the database (not a
stubs-only test) refuses to run under `node --test`/`npm test` unless
`TEST_DATABASE_URL` is set (`src/utils/dbSafety.js`; `ALLOW_SHARED_PRODUCTION_DB` is
**not** honored in a test context, on purpose). Stand up a real, separate database —
Postgres **17**, pinned to match production, not a newer major:

```bash
docker run -d --name wasi-test-postgres -p 5433:5432 \
  -e POSTGRES_USER=wasi_test -e POSTGRES_PASSWORD=wasi_test_pw \
  -e POSTGRES_DB=wasi_test postgres:17-alpine
```

Setting `TEST_DATABASE_URL` alone only satisfies the guard's presence check —
`src/db/pool.js` always connects using `DATABASE_URL`, so point both at the test
database for the invocation (don't put this value in your real `.env`'s
`DATABASE_URL` — that would repoint `npm run dev` at it too):

```bash
export DATABASE_URL="postgres://wasi_test:wasi_test_pw@localhost:5433/wasi_test?sslmode=disable"
export TEST_DATABASE_URL="$DATABASE_URL"
npx node-pg-migrate up -m src/db/migrations
node src/db/seed.js
node src/db/seedTemplateLibrary.js   # needed by the Template Library UI tests
npm test                              # port 4000 must be free — Playwright tests hard-code it
```

Run one test file at a time against this database, never alongside another test
process — two `node --test` invocations hitting the same database concurrently race
each other (confirmed to produce real, confusing failures; see "Conventions" in the
root `CLAUDE.md`).

## Auth

Real JWT auth for both actor types — no dev header stub. `POST /api/auth/register` /
`/login` (clients), `POST /api/admin/auth/login` (admins, seeded via `db:seed` or
`POST /api/admin/admin-users`). Forgot/reset password and email
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
