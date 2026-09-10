// UI/UX consistency pass, Group 5 — marketing/reset-password.html and
// marketing/accept-team-invite.html both used class="banner", a class never
// defined anywhere in marketing.css — 100% of their visual styling came
// from hand-duplicated inline styles that only approximately matched the
// signup wizard's real, already-themed .form-error-banner. Swapped both to
// the real class (and to the wizard's established classList.add/remove
// ('visible') toggle, instead of manipulating style.display directly).
// marketing/verify-email.html had NO banner styling at all — success and
// failure looked visually identical (plain black text either way). Now
// routes both through the same real .form-info-banner/.form-error-banner
// classes via a small showOutcome() helper.
//
// This test proves all three actually render with real theming (a real
// background-color, not transparent/inherited) at 1366x768 and a mobile
// width, and that verify-email's success vs. failure cases are genuinely
// visually distinct, not just class-name cosmetics.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.ALLOWED_ORIGINS = 'http://localhost:4000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const authTokensRepo = require('../src/repositories/authTokensRepo');

let server, baseUrl, browser, testClientId;

const SUITE_PREFIX = '__test_suite__marketingbanners5_';
const EMAIL = `test-suite-marketingbanners5-${Date.now()}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';

before(async () => {
  const app = createApp();
  server = app.listen(4000);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = 'http://localhost:4000';

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${SUITE_PREFIX}client`, email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json());
  testClientId = registered.client?.id;
  assert.ok(testClientId, 'dedicated test client registration must succeed');

  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// A visible .form-error-banner/.form-info-banner must have a real,
// non-transparent background-color — this is what actually distinguishes
// "real theming" from the old class="banner" (which rendered with zero
// class-driven styling at all once its hand-duplicated inline styles were
// the only thing carrying it).
async function assertRealBackground(locator) {
  const bg = await locator.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(bg, 'rgba(0, 0, 0, 0)', 'banner must have a real background-color, not transparent/unstyled');
  assert.notEqual(bg, 'transparent');
  return bg;
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 375, height: 812 }]) {
  const label = `${viewport.width}x${viewport.height}`;

  test(`${label}: reset-password.html shows a real themed error banner, not the old undefined "banner" class`, async () => {
    const page = await browser.newPage({ viewport });
    await page.goto(`${baseUrl}/marketing/reset-password.html?token=invalid-test-token`);
    await page.fill('#new-password', 'irrelevant-password-123');
    await page.click('#reset-submit');
    await page.waitForTimeout(500);

    const errorEl = page.locator('#reset-error');
    await assert.doesNotReject(() => errorEl.waitFor({ state: 'visible', timeout: 3000 }));
    assert.ok(await errorEl.evaluate((el) => el.classList.contains('form-error-banner') && el.classList.contains('visible')));
    await assertRealBackground(errorEl);
    const text = await errorEl.textContent();
    assert.ok(text && text.trim().length > 0, 'the real backend error message must be shown, not an empty banner');

    await page.close();
  });

  test(`${label}: accept-team-invite.html shows a real themed error banner`, async () => {
    const page = await browser.newPage({ viewport });
    await page.goto(`${baseUrl}/marketing/accept-team-invite.html?token=invalid-test-token`);
    await page.fill('#new-password', 'irrelevant-password-123');
    await page.click('#invite-submit');
    await page.waitForTimeout(500);

    const errorEl = page.locator('#invite-error');
    await assert.doesNotReject(() => errorEl.waitFor({ state: 'visible', timeout: 3000 }));
    assert.ok(await errorEl.evaluate((el) => el.classList.contains('form-error-banner') && el.classList.contains('visible')));
    await assertRealBackground(errorEl);

    await page.close();
  });

  test(`${label}: verify-email.html — failure and success are now genuinely visually distinct, not identical plain text`, async () => {
    const failPage = await browser.newPage({ viewport });
    await failPage.goto(`${baseUrl}/marketing/verify-email.html?token=invalid-test-token`);
    const failMsg = failPage.locator('#verify-message');
    await assert.doesNotReject(() => failMsg.evaluate(
      (el) => new Promise((resolve) => {
        if (el.classList.contains('form-error-banner')) return resolve();
        const obs = new MutationObserver(() => { if (el.classList.contains('form-error-banner')) { obs.disconnect(); resolve(); } });
        obs.observe(el, { attributes: true, attributeFilter: ['class'] });
      })
    ));
    const failBg = await assertRealBackground(failMsg);
    await failPage.close();

    const realToken = await authTokensRepo.create('client', testClientId, 'email_verification', 60);
    const okPage = await browser.newPage({ viewport });
    await okPage.goto(`${baseUrl}/marketing/verify-email.html?token=${encodeURIComponent(realToken)}`);
    const okMsg = okPage.locator('#verify-message');
    await assert.doesNotReject(() => okMsg.evaluate(
      (el) => new Promise((resolve) => {
        if (el.classList.contains('form-info-banner')) return resolve();
        const obs = new MutationObserver(() => { if (el.classList.contains('form-info-banner')) { obs.disconnect(); resolve(); } });
        obs.observe(el, { attributes: true, attributeFilter: ['class'] });
      })
    ));
    const okBg = await assertRealBackground(okMsg);
    await okPage.close();

    assert.notEqual(okBg, failBg, 'success and failure must render with genuinely different colors, not look identical as before');
  });
}
