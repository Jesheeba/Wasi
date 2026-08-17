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

module.exports = { authLimiter, webhookLimiter };
