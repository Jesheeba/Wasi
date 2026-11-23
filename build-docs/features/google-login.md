# Continue with Google

## Purpose
Let a new customer create a Wasi account, and an existing one log in, with
their Google account instead of a password. Removes the password step from
onboarding.

## Architecture
- Google Identity Services (`https://accounts.google.com/gsi/client`) renders
  the button and returns a signed **ID token** to the page (popup mode).
- `POST /api/auth/google { credential, intent: 'signup'|'login', businessName? }`
  verifies it in `utils/googleIdToken.js`: Google's published keys (JWKS,
  cached per Cache-Control), RS256 only, `aud` = `GOOGLE_CLIENT_ID`, issuer
  Google, not expired, `email_verified` true. jsonwebtoken + Node crypto; no
  new dependency, **no client secret anywhere**.
- Matching: `clients.google_sub` (migration 104) first, then email
  (case-insensitive; Google has verified it, so it is linked), else signup
  creates a `pending_setup` client with no password and `email_verified`.
  `intent: 'login'` never creates an account (404 `no_account` -> signup page).
- `GET /api/auth/google/config` returns the public client id or null; both
  buttons stay hidden when it is null, so nothing changes until it is set.
- UI: signup step 1 (a Google sign-in before the business name is typed is
  held; the main button becomes "Finish with Google"), then the normal wizard
  (plan, WhatsApp). App login screen: existing accounts sign in.

## Impact map
- `routes/auth.js` (new routes, same `authLimiter` as password login).
- `clients` table: new nullable unique `google_sub`; not in SAFE_COLUMNS, not
  granted to wasi_app (only the privileged auth route reads it).
- `marketing/signup.*`, `index.html` login card, `app.js` (login), CSS.
- Password login unaffected; a Google-only account can add a password via
  "Forgot password".
- Fixed while here: the login screen's "Signup" link was `href="#"`.

## Edge cases
- No business name: held credential, field error; 400 from the API if called directly.
- Email already linked to a different Google account: 409 (no takeover).
- Forged/expired/wrong-audience/unverified tokens: 401; nothing created.
- Google keys unreachable: 500 path (not the user's fault), logged.
- Rate limit: 20 auth attempts / 15 min / IP, shared with password login.
- Team members and admin keep their own logins (out of scope).

## Acceptance criteria
1. No `GOOGLE_CLIENT_ID` -> no button, endpoints 503/null.
2. New Google signup -> verified, password-less, pending_setup account, then plan step.
3. Missing business name -> nothing created; login screen never creates.
4. Existing account (any email case) is linked and signed in; password still works; account found by Google id after an email change; no takeover by another Google account.
5. Every forged token rejected.

## Owner actions
- Create the OAuth client in Google Cloud (Web application; authorised
  JavaScript origins `https://wasi.sirahagents.com`, `http://localhost:4000`).
- Set `GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com` in the VPS env, deploy.
- OAuth consent screen: app name, support email, logo; publish to "In
  production" (only basic scopes `openid email profile` are used, which need
  no Google verification review).
