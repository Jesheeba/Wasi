# Deploying Wasi CRM

One Express service (`server/`) serves the API **and** all three static frontends
(root CRM at `/`, `/admin`, `/marketing`) from a single origin — see the static
mounts in `server/src/app.js`. Database is Supabase Postgres. This doc is the
exact path from "code on disk" to "live URL." Once deployed, see
`GO_LIVE_CHECKLIST.md` for the Meta/Razorpay account-side steps needed before
real clients can use it (App Review, live payment keys, etc.) — those are
account approvals outside this repo, not code changes.

## 1. Supabase (already provisioned)

Use the **connection pooler** string, not the direct `db.<ref>.supabase.co`
host — that host is IPv6-only and will fail to resolve (`ENOTFOUND`) from most
networks and from Render. Get it from Supabase dashboard → Project Settings →
Database → Connection string → mode **Transaction** (port 6543):

```
postgresql://postgres.<project-ref>:<url-encoded-password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

- URL-encode any special characters in the password (e.g. `@` → `%40`).
- Do **not** append `?sslmode=require` to this string — `server/src/db/pool.js`
  already sets `ssl: { rejectUnauthorized: false }` for any non-localhost
  host, and combining that with a `sslmode` query param causes a
  `self-signed certificate in certificate chain` connection failure (verified
  during this build). For the CLI (`node-pg-migrate`, which doesn't go
  through `pool.js`), set `PGSSLMODE=no-verify` in the environment instead —
  already wired into `server/.env.example` and `render.yaml`.

## 2. Push to a git remote

No git repo exists in this project yet. Render deploys from GitHub/GitLab, so:

```bash
git init
git add .
git commit -m "Initial commit"
# create an empty repo on GitHub first, then:
git remote add origin <your-repo-url>
git push -u origin main
```

Double-check `git status` before the first `add` — `.gitignore` (repo root)
already excludes `node_modules/`, `server/.env`, and `server/.pgdata/`, but
confirm no secrets got staged before pushing anywhere.

## 3. Render

`render.yaml` at the repo root is a Blueprint — Render → New → Blueprint →
point at your repo, it reads the file automatically. It defines one web
service (`rootDir: server`, `npm install` → `npm run db:migrate` (pre-deploy)
→ `npm start`), with `JWT_SECRET`/`SERVER_SECRET`/`META_WEBHOOK_VERIFY_TOKEN`
auto-generated and everything else (`sync: false`) prompted for at setup:

- `DATABASE_URL` — the Supabase pooler string from step 1
- `ALLOWED_ORIGINS` — your Render URL, e.g. `https://wasi-crm.onrender.com`
  (needed for the local-dev split-origin case; same-origin production
  requests don't require this, see `server/src/app.js`)
- `META_APP_ID` / `META_APP_SECRET` / `META_CONFIG_ID` — from Meta App
  Dashboard once created (see Phase 7 checklist)
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` —
  from Razorpay dashboard
- `RESEND_API_KEY` / `EMAIL_FROM` — for password reset / verification emails

Leave the Meta/Razorpay/email vars blank to deploy now and fill them in later —
every integration in this codebase degrades to a clear `503`/error response
rather than crashing when its credentials are absent (see `metaClient.js`,
`onboarding.js`, `billing.js`).

## 4. Post-deploy verification

```bash
curl https://<your-render-url>/health
# {"status":"ok","db":"connected",...}

curl -X POST https://<your-render-url>/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@wasi.local","password":"demo12345"}'
# returns a JWT — confirms auth + DB round-trip in production
```

Then open `https://<your-render-url>/` (CRM), `/admin` (admin panel — login
`admin@wasi.local` / `admin12345`, seeded), and `/marketing` (landing +
signup wizard) in a browser.

**Before onboarding real clients:** rotate the seeded demo credentials, set
real `JWT_SECRET`/`SERVER_SECRET` if Render's auto-generated ones weren't
used, and complete the Meta/Razorpay checklists in the platform spec before
sending real client data through this deployment.
