// UI/UX consistency pass, Group 2/3 — this app had 6 native confirm() calls
// and 2 native prompt() calls, each an unstyled browser dialog with none of
// the app's own theming, sitting alongside every other action's real modal.
// Ported admin/app.js's showConfirm into app.js (root) as showConfirm() +
// closeConfirm(), reusing the exact same pattern (re-cloning the action
// button on every open so listeners never stack), and added showPrompt() —
// a genuine prompt() replacement, not just confirm()'s — by injecting a
// text <input> into the same #modal-confirm markup. Per direct instruction,
// a prompt replacement without autofocus-on-open and Enter-to-submit would
// be a downgrade from the native dialog it replaces, so both are proven
// here, not just that a themed dialog now exists.
//
// This test proves, at 1366x768 and a mobile width:
//  1. A confirm() site (logout) now shows the real themed modal — not the
//     browser's native dialog — and Cancel vs. Confirm both behave
//     correctly (stays logged in / actually logs out).
//  2. A prompt() site (forgot password, pre-login) autofocuses its input on
//     open and submits on Enter, driving the real request through.
//  3. A second prompt() site (API key creation, post-login) proves the same
//     autofocus+Enter behavior end-to-end creates a real API key — not just
//     that the dialog opens.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.ALLOWED_ORIGINS = 'http://localhost:4000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server, baseUrl, browser;

const SUITE_PREFIX = '__test_suite__confirmprompt23_';
const EMAIL = `test-suite-confirmprompt23-${Date.now()}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';

before(async () => {
  const app = createApp();
  server = app.listen(4000);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = 'http://localhost:4000';

  await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${SUITE_PREFIX}client`, email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json());

  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function login(page) {
  await page.goto(`${baseUrl}/`);
  await page.fill('#login-email', EMAIL);
  await page.fill('#login-password', PASSWORD);
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(1000);
  const mobileToggle = page.locator('#mobile-sidebar-toggle-btn');
  if (await mobileToggle.isVisible().catch(() => false)) {
    await mobileToggle.click();
    await page.waitForTimeout(300);
  }
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 375, height: 812 }]) {
  const label = `${viewport.width}x${viewport.height}`;

  test(`${label}: logout confirm() site — real themed modal, Cancel keeps the session, Confirm logs out`, async () => {
    const page = await browser.newPage({ viewport });
    await login(page);

    await page.click('#user-profile-item');
    // .modal-overlay only ever toggles opacity/pointer-events, never
    // display:none (index.css) — Playwright's visible/hidden locator
    // states don't key off opacity, so they'd report "visible" even
    // before .open is added. Assert on the .open class itself instead,
    // same fix Group 4's test already established for this exact class of
    // element (page.waitForSelector('#id.open', ...)).
    await page.waitForSelector('#modal-confirm.open', { timeout: 3000 });
    assert.equal(await page.locator('#modal-confirm-title').textContent(), 'Log out?');
    // Real theming, not a bare native dialog — a non-transparent background.
    const bg = await page.locator('#modal-confirm .modal-box').evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(bg, 'rgba(0, 0, 0, 0)');

    // Cancel — session must survive. The Cancel button and the header's X
    // button both carry data-close-modal="modal-confirm" (by design, both
    // close it), so target Cancel specifically by its text to keep this a
    // single, unambiguous click.
    await page.locator('#modal-confirm').getByText('Cancel', { exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('modal-confirm').classList.contains('open'), { timeout: 3000 });
    assert.notEqual(await page.evaluate(() => localStorage.getItem('client_token')), null,
      'cancelling logout must not have logged the user out');

    // Confirm — must actually log out. At mobile widths, interacting with
    // the confirm modal closes the mobile sidebar drawer as a side effect
    // (clicking outside the drawer, which the modal's Cancel button
    // counts as, closes it) — same re-toggle-if-needed pattern login()
    // uses, since #user-profile-item lives inside that drawer. The drawer
    // moves off-canvas via `transform`, not display/visibility, so check
    // its .mobile-open class directly rather than #user-profile-item's
    // own (misleadingly true) isVisible().
    const mobileToggleAgain = page.locator('#mobile-sidebar-toggle-btn');
    if (await mobileToggleAgain.isVisible().catch(() => false)) {
      const sidebarOpen = await page.locator('#sidebar').evaluate((el) => el.classList.contains('mobile-open')).catch(() => false);
      if (!sidebarOpen) {
        await mobileToggleAgain.click();
        await page.waitForTimeout(300);
      }
    }
    await page.click('#user-profile-item');
    await page.waitForSelector('#modal-confirm.open', { timeout: 3000 });
    await page.click('#modal-confirm-action-btn');
    await page.waitForFunction(() => localStorage.getItem('client_token') === null, { timeout: 3000 });

    await page.close();
  });

  test(`${label}: forgot-password prompt() site — input autofocuses on open, Enter submits`, async () => {
    const page = await browser.newPage({ viewport });
    await page.goto(`${baseUrl}/`);
    await page.waitForTimeout(500);

    await page.click('#forgot-password-link');
    await page.waitForSelector('#modal-confirm.open', { timeout: 3000 });
    const input = page.locator('#modal-confirm-prompt-input');
    await input.waitFor({ state: 'attached', timeout: 3000 });
    assert.ok(await input.evaluate((el) => el === document.activeElement), 'the prompt input must autofocus on open');

    await input.fill('someone@example.com');
    await input.press('Enter');
    // A real submit was driven by Enter (not just typing) — the modal
    // closes and the real backend response reaches the user as a toast.
    await page.waitForFunction(() => !document.getElementById('modal-confirm').classList.contains('open'), { timeout: 3000 });
    await assert.doesNotReject(() => page.locator('.toast').first().waitFor({ state: 'attached', timeout: 3000 }));

    await page.close();
  });

  test(`${label}: API key creation prompt() site — autofocus + Enter creates a real key end-to-end`, async () => {
    const page = await browser.newPage({ viewport });
    await login(page);

    await page.click('.nav-item[data-view="settings"]');
    await page.waitForTimeout(500);
    await page.click('.sec-nav-item[data-sec-view="developer"]');
    await page.waitForTimeout(500);

    await page.click('#new-api-key-btn');
    await page.waitForSelector('#modal-confirm.open', { timeout: 3000 });
    const input = page.locator('#modal-confirm-prompt-input');
    await input.waitFor({ state: 'attached', timeout: 3000 });
    assert.ok(await input.evaluate((el) => el === document.activeElement), 'the prompt input must autofocus on open');

    await input.fill(`${SUITE_PREFIX}key-${viewport.width}`);
    await input.press('Enter');

    await page.waitForFunction(() => !document.getElementById('modal-confirm').classList.contains('open'), { timeout: 3000 });
    const revealEl = page.locator('#new-api-key-reveal');
    await assert.doesNotReject(() => revealEl.waitFor({ state: 'visible', timeout: 3000 }));
    const keyValue = await page.locator('#new-api-key-value').inputValue();
    assert.ok(keyValue && keyValue.length > 0, 'Enter must have driven a real key creation, not a no-op');

    await page.close();
  });
}
