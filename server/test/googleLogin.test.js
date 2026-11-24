// "Continue with Google" (build-docs/features/google-login.md). Test names
// start with the acceptance criterion they cover.
//
// No real Google: a test RSA key pair stands in for Google's signing key
// (googleIdToken.fetchJwks is replaced to publish its public half), so the
// real verification code runs unchanged. The browser tests replace Google's
// gsi/client script with a stub that hands the page a token signed the same
// way. Own port opened as http://[::1] so app.js never calls :4000.
// Disposable __test_suite__ clients, deleted in after().
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const PORT = 4108;
process.env.ALLOWED_ORIGINS = `http://[::1]:${PORT}`;
const CLIENT_ID = 'test-client-123.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_ID = CLIENT_ID;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const googleIdToken = require('../src/utils/googleIdToken');

const BASE = `http://[::1]:${PORT}`;
const SUITE = '__test_suite__google_';
const stamp = Date.now();
const emails = [];
let server, browser;

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const KID = 'test-kid-1';

function googleToken(overrides = {}, { key = privateKey, kid = KID, expiresIn = '1h', header } = {}) {
  const sub = overrides.sub || `sub-${crypto.randomUUID()}`;
  const payload = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub, email: `x-${sub}@example.com`, email_verified: true, name: 'Test User', ...overrides };
  if (header) return jwt.sign(payload, key, { header, expiresIn });
  return jwt.sign(payload, key, { algorithm: 'RS256', keyid: kid, expiresIn });
}
const email = (tag) => { const e = `test-suite-google-${tag}-${stamp}@wasi.local`; emails.push(e.toLowerCase()); return e; };
// Each API call identifies as its own visitor (the app trusts one proxy hop):
// the 20-per-15-min auth limiter is per IP, and these tests alone exceed it.
let ipCounter = 0;
const post = (path, body, ip = `10.77.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const clientRow = async (e) => (await pool.query('select * from clients where lower(email) = lower($1)', [e])).rows[0];

before(async () => {
  googleIdToken.fetchJwks = async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }], maxAgeSeconds: 3600 });
  googleIdToken._resetCache();
  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await pool.query('delete from clients where lower(email) = any($1::text[])', [emails]).catch(() => {});
  await pool.end();
});

// ------------------------------------------------------------- API
test('AC1: config exposes only the public client id; nothing works without it', async () => {
  const cfg = await fetch(`${BASE}/api/auth/google/config`).then((r) => r.json());
  assert.deepEqual(cfg, { clientId: CLIENT_ID });
  delete process.env.GOOGLE_CLIENT_ID;
  try {
    assert.deepEqual(await fetch(`${BASE}/api/auth/google/config`).then((r) => r.json()), { clientId: null });
    assert.equal((await post('/api/auth/google', { credential: googleToken(), intent: 'login' })).status, 503);
  } finally { process.env.GOOGLE_CLIENT_ID = CLIENT_ID; }
});

test('AC2: signup with Google creates a verified, password-less pending_setup account and a working session', async () => {
  const e = email('new');
  const res = await post('/api/auth/google', { credential: googleToken({ email: e }), intent: 'signup', businessName: '  Priya Boutique  ' });
  assert.equal(res.status, 201); assert.equal(res.body.created, true);
  assert.doesNotMatch(JSON.stringify(res.body), /google_sub|password_hash/, 'internal columns never returned');
  const row = await clientRow(e);
  assert.equal(row.name, 'Priya Boutique'); assert.equal(row.status, 'pending_setup');
  assert.equal(row.email_verified, true); assert.equal(row.password_hash, null); assert.ok(row.google_sub);
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${res.body.token}` } });
  assert.equal(me.status, 200);
  const pw = await post('/api/auth/login', { email: e, password: 'anything-at-all' });
  assert.equal(pw.status, 401, 'a Google-only account has no password to guess');
});

test('AC3: no business name -> 400 and nothing is created; the login screen never creates an account', async () => {
  const e = email('noname');
  const r1 = await post('/api/auth/google', { credential: googleToken({ email: e }), intent: 'signup' });
  assert.equal(r1.status, 400); assert.equal(r1.body.code, 'business_name_required');
  const r2 = await post('/api/auth/google', { credential: googleToken({ email: e }), intent: 'login' });
  assert.equal(r2.status, 404); assert.equal(r2.body.code, 'no_account');
  assert.equal(await clientRow(e), undefined);
  assert.equal((await post('/api/auth/google', { credential: googleToken({ email: e }), intent: 'signup', businessName: 'x'.repeat(121) })).status, 400);
});

test('AC4: an existing password account (any email case) is linked and signed in; password still works; same Google account returns to it', async () => {
  const e = email('existing');
  await post('/api/auth/register', { businessName: `${SUITE}existing`, email: e.toUpperCase().replace('@WASI.LOCAL', '@wasi.local'), password: 'test-suite-password-12345' });
  const sub = `sub-existing-${stamp}`;
  const r = await post('/api/auth/google', { credential: googleToken({ sub, email: e }), intent: 'login' });
  assert.equal(r.status, 200); assert.equal(r.body.created, false);
  const row = await clientRow(e);
  assert.equal(row.google_sub, sub); assert.equal(row.email_verified, true);
  const pw = await post('/api/auth/login', { email: row.email, password: 'test-suite-password-12345' });
  assert.equal(pw.status, 200, 'password login unaffected');
  const again = await post('/api/auth/google', { credential: googleToken({ sub, email: 'changed-address@example.com' }), intent: 'signup', businessName: 'Ignored' });
  assert.equal(again.status, 200); assert.equal(again.body.client.id, row.id, 'matched by Google id even after the email changed');
  const other = await post('/api/auth/google', { credential: googleToken({ sub: 'a-different-google-account', email: e }), intent: 'login' });
  assert.equal(other.status, 409, 'an email linked to one Google account cannot be taken over by another');
});

test('AC5: forged or invalid tokens are rejected with 401 and create nothing', async () => {
  const e = email('forged');
  const bad = {
    'wrong audience': googleToken({ email: e, aud: 'someone-else.apps.googleusercontent.com' }),
    'wrong issuer': googleToken({ email: e, iss: 'https://evil.example.com' }),
    expired: googleToken({ email: e }, { expiresIn: -10 }),
    'signed by another key': googleToken({ email: e }, { key: otherKey }),
    'unknown key id': googleToken({ email: e }, { kid: 'nope' }),
    'email not verified': googleToken({ email: e, email_verified: false }),
    'HS256 with a guessable secret': googleToken({ email: e }, { key: 'secret', header: { alg: 'HS256', kid: KID } }),
    garbage: 'x'.repeat(40),
  };
  for (const [label, credential] of Object.entries(bad)) {
    const r = await post('/api/auth/google', { credential, intent: 'signup', businessName: 'Forged' });
    assert.ok([400, 401].includes(r.status), `${label}: got ${r.status}`);
  }
  assert.equal(await clientRow(e), undefined);
});

test('security: the Google endpoint is behind the same brute-force limiter as password login', async () => {
  const statuses = [];
  for (let i = 0; i < 21; i += 1) statuses.push((await post('/api/auth/google', { credential: 'x'.repeat(40), intent: 'login' }, '10.99.99.99')).status);
  assert.equal(statuses[19], 401, 'rejected as unverifiable, not rate-limited yet'); assert.equal(statuses[20], 429, '21st attempt in 15 min is refused');
});

// ------------------------------------------------------------- browser
// Stand-in for https://accounts.google.com/gsi/client: renders a button that
// returns the credential the test put on window.__testCredential.
const GSI_STUB = `window.google = { accounts: { id: {
  initialize(cfg) { window.__gsiConfig = cfg; },
  renderButton(el) { const b = document.createElement('button'); b.type = 'button'; b.id = 'gsi-stub-button';
    b.textContent = 'Continue with Google'; b.onclick = () => window.__gsiConfig.callback({ credential: window.__testCredential }); el.appendChild(b); },
} } };`;

async function page(path, credential) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  p.setDefaultTimeout(10000);
  await p.route((url) => url.port === '4000', (r) => r.abort());
  await p.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ contentType: 'application/javascript', body: GSI_STUB }));
  await p.addInitScript((c) => { window.__testCredential = c; }, credential);
  await p.goto(`${BASE}${path}`);
  return p;
}

test('AC2 (UI): signup - Google first, then business name, then straight to the plan step', async () => {
  const e = email('ui-signup');
  const p = await page('/marketing/signup.html', googleToken({ email: e }));
  await p.waitForSelector('#google-signin:not([hidden]) #gsi-stub-button');
  await p.click('#gsi-stub-button');
  await p.waitForFunction(() => document.getElementById('password-group').hidden);
  assert.match(await p.textContent('[data-error-for="businessName"]'), /business name/i);
  assert.match(await p.textContent('#step1-submit'), /Finish with Google/);
  assert.equal(await p.inputValue('#email'), e, 'the Google email is shown, not an empty box');
  assert.ok(await p.$eval('#email', (el) => el.readOnly), 'and it cannot be edited');
  await p.fill('#businessName', `${SUITE}ui shop`);
  await p.click('#step1-submit');
  await p.waitForSelector('.wizard-step[data-step="2"]:not([hidden])');
  const row = await clientRow(e);
  assert.ok(row && row.google_sub); assert.equal(row.name, `${SUITE}ui shop`);
  assert.ok(await p.evaluate(() => localStorage.getItem('client_token')), 'session stored for the next steps');
  await p.close();
});

test('AC4 (UI): login screen - existing account enters the app; unknown Google account is sent to signup', async () => {
  const e = email('ui-login');
  const sub = `sub-ui-login-${stamp}`;
  await post('/api/auth/google', { credential: googleToken({ sub, email: e }), intent: 'signup', businessName: `${SUITE}ui login` });
  let p = await page('/app', googleToken({ sub, email: e }));
  await p.waitForSelector('#google-login:not([hidden]) #gsi-stub-button');
  assert.equal(await p.getAttribute('a[href="/marketing/signup.html"]', 'href'), '/marketing/signup.html', 'Signup link now goes somewhere');
  await p.click('#gsi-stub-button');
  // Same check as chatUiPass/broadcastPauseResumeUI: Playwright's own visibility test misreads this layout.
  await p.waitForFunction(() => getComputedStyle(document.getElementById('app-shell')).display !== 'none');
  assert.match(await p.textContent('.sidebar'), /ui login/, 'signed in as the Google account');
  await p.close();

  p = await page('/app', googleToken({ email: email('ui-unknown') }));
  await p.waitForSelector('#gsi-stub-button');
  await p.click('#gsi-stub-button');
  await p.waitForURL('**/marketing/signup.html', { timeout: 8000 });
  // The Google sign-in carries over: email filled and locked, only the business name is asked for.
  await p.waitForFunction((em) => document.getElementById('email').value === em, email('ui-unknown'));
  assert.ok(await p.$eval('#email', (el) => el.readOnly));
  assert.ok(await p.$eval('#password-group', (el) => el.hidden));
  assert.equal(await p.evaluate(() => sessionStorage.getItem('wasi_google_signup_credential')), null, 'read once');
  await p.fill('#businessName', `${SUITE}ui handover`);
  await p.click('#step1-submit');
  await p.waitForSelector('.wizard-step[data-step="2"]:not([hidden])');
  assert.equal((await clientRow(email('ui-unknown'))).name, `${SUITE}ui handover`);
  await p.close();
});

test('coupon (UI): the signup plan step checks a coupon with the server and sends it to checkout', async () => {
  const e = email('ui-coupon');
  const p = await page('/marketing/signup.html', googleToken({ email: e }));
  await p.fill('#businessName', `${SUITE}ui coupon`);
  await p.waitForSelector('#gsi-stub-button');
  await p.click('#gsi-stub-button');
  await p.waitForSelector('.wizard-step[data-step="2"]:not([hidden])');
  assert.ok(await p.isVisible('#coupon-code'), 'coupon box is shown on the plan step');

  await p.fill('#coupon-code', 'NOT-A-CODE');
  await p.click('#coupon-apply-btn');
  await p.waitForFunction(() => document.getElementById('coupon-status').classList.contains('bad'));
  assert.match(await p.textContent('#coupon-status'), /invalid/i);

  await p.fill('#coupon-code', 'wasimr10');
  await p.click('#coupon-apply-btn');
  await p.waitForFunction(() => document.getElementById('coupon-status').classList.contains('ok'));
  assert.match(await p.textContent('#coupon-status'), /WASIMR10 applied: ₹1\/month/);

  const checkout = p.waitForRequest((r) => r.url().endsWith('/api/billing/checkout'));
  await p.click('#step2-checkout-btn');
  assert.equal(JSON.parse((await checkout).postData()).couponCode, 'WASIMR10', 'checkout is charged with the coupon');

  // Switching plan drops the coupon: it is checked per plan.
  await p.click('.plan-option:not(.selected)');
  assert.equal(await p.textContent('#coupon-status'), '');
  await p.close();
});

test('AC1 (UI): without GOOGLE_CLIENT_ID no Google button is shown anywhere', async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  try {
    for (const path of ['/marketing/signup.html', '/app']) {
      const p = await page(path, 'unused');
      await p.waitForTimeout(1500);
      assert.equal(await p.locator('#gsi-stub-button').count(), 0, path);
      await p.close();
    }
  } finally { process.env.GOOGLE_CLIENT_ID = CLIENT_ID; }
});
