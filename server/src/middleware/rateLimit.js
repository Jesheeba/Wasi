const rateLimit = require('express-rate-limit');

// Brute-force protection on login/register. Keyed by IP; generous enough for
// a real user mistyping a password a few times, tight enough to slow credential stuffing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' },
});

// Meta/Razorpay webhooks are already gated by HMAC signature verification;
// this just caps abuse volume from callers who know the public URL but not the secret.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
});

// Hub API (build plan Phase 5) — server-to-server, so a much higher ceiling
// than a browser-facing limiter, but still bounded: a leaked/compromised API
// key shouldn't be able to hammer this without limit just because it's a
// valid credential.
//
// legacyHeaders is on (unlike authLimiter/webhookLimiter above) specifically
// to emit X-RateLimit-Limit/Remaining/Reset on every /api/v1/* response —
// wasi-master-plan.md §8.6's rate-limit visibility requirement. This is
// express-rate-limit's own built-in header set (see its setLegacyHeaders),
// not custom Wasi logic, and it fires on both allowed and 429 responses for
// free. standardHeaders (the draft RateLimit-* headers) stays on too —
// additive, already present before this change, no reason to remove it.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: true,
  // Hub API v1's own {error: {code, message}} shape (utils/apiError.js),
  // not the plain {error: 'string'} authLimiter/webhookLimiter above use —
  // a 429 from this limiter is still a /api/v1/* response and must match
  // every other error this API returns.
  message: { error: { code: 'rate_limited', message: 'Too many requests.' } },
});

// Client self-serve API key creation (build plan Phase 4, routes/apiKeys.js
// POST /) — mints a live Bearer credential on every call, the one
// capability this route family didn't have to consider abuse-throttling for
// until now (independent audit finding: unlike every /api/v1/* route above,
// nothing bounded how many keys an authenticated client could mint in a
// loop). Keyed by the authenticated client (req.clientId), not IP — the
// abuse case here is one account looping this endpoint after a valid
// login, not one IP spreading requests across accounts.
const apiKeyCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.clientId || req.ip,
  message: { error: 'Too many API keys created recently. Try again later, or contact support if you need more.' },
});

// Client "who am I" session check (routes/auth.js's GET /me,
// POST /verify-email/request) — called on every page load/reload to
// resume a session. Fundamentally different risk profile from
// /login /register /forgot-password /reset-password: it already requires
// a valid signed JWT to do anything (requireClientAuth runs first), so
// brute-forcing it isn't a meaningful attack the way guessing a password
// is. Found live (2026-09-01): these routes used to share authLimiter's
// 20-per-15-min bucket with /login and /register — a client who simply
// reloaded the app repeatedly during completely normal use could exhaust
// it purely from routine session checks, and land on a bare,
// unexplained login screen for up to 15 minutes with no visible error
// (the resume-check IIFE in app.js correctly doesn't wipe the token on a
// non-401 failure — see that fix's own history — but a 429 here still
// means neither the resume-confirmation card nor the app ever appears).
// 60/min is generous enough that even reloading every few seconds
// wouldn't hit it, while still bounding abuse of an authenticated
// endpoint (e.g. reconnaissance with a stolen token).
const sessionCheckLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again shortly.' },
});

module.exports = { authLimiter, webhookLimiter, apiLimiter, apiKeyCreationLimiter, sessionCheckLimiter };
