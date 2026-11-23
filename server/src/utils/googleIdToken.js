// Verifies a Google Identity Services ID token ("Continue with Google").
// Uses Google's published signing keys (JWKS) with jsonwebtoken, already a
// dependency; no client secret is involved anywhere in this flow.
//
// Checks, all required: RS256 signature by a current Google key, audience =
// our GOOGLE_CLIENT_ID, issuer = Google, not expired, email_verified = true.
// `fetchJwks` is replaceable so tests can sign with their own key.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

let cache = { keys: null, expiresAt: 0 };

async function defaultFetchJwks() {
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Google keys request failed (${res.status})`);
  const maxAge = Number((res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1]) || 3600;
  return { keys: (await res.json()).keys, maxAgeSeconds: maxAge };
}

async function getKey(kid, fetchJwks) {
  if (!cache.keys || Date.now() > cache.expiresAt || !cache.keys.some((k) => k.kid === kid)) {
    const { keys, maxAgeSeconds } = await fetchJwks();
    cache = { keys, expiresAt: Date.now() + maxAgeSeconds * 1000 };
  }
  const jwk = cache.keys.find((k) => k.kid === kid);
  if (!jwk) throw Object.assign(new Error('Unknown Google signing key'), { code: 'invalid_token' });
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

class GoogleTokenError extends Error {
  constructor(message) { super(message); this.code = 'invalid_token'; }
}

// Returns { sub, email, name } or throws GoogleTokenError.
async function verifyGoogleIdToken(idToken, { clientId = process.env.GOOGLE_CLIENT_ID, fetchJwks = module.exports.fetchJwks } = {}) {
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not configured');
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header || decoded.header.alg !== 'RS256' || !decoded.header.kid) {
    throw new GoogleTokenError('Malformed Google token');
  }
  let payload;
  try {
    payload = jwt.verify(idToken, await getKey(decoded.header.kid, fetchJwks), {
      algorithms: ['RS256'], audience: clientId, issuer: ISSUERS,
    });
  } catch (err) {
    if (err.code === 'invalid_token') throw new GoogleTokenError(err.message);
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
      throw new GoogleTokenError(err.message);
    }
    throw err; // network failure fetching keys etc. - not the user's fault
  }
  if (payload.email_verified !== true || !payload.email || !payload.sub) {
    throw new GoogleTokenError('This Google account has no verified email address');
  }
  return { sub: payload.sub, email: String(payload.email).toLowerCase(), name: payload.name || '' };
}

module.exports = { verifyGoogleIdToken, fetchJwks: defaultFetchJwks, GoogleTokenError, _resetCache: () => { cache = { keys: null, expiresAt: 0 }; } };
