// Long/actionable-error dialog — showToast is a small auto-dismissing
// bubble, the wrong shape for a real Meta rejection, a multi-reason
// template-validation `details` array, or embedded-signup guidance text
// (all real, currently-produced error shapes — see CLAUDE.md's Known Gaps
// for examples of each). reportError() (app.js), the new single entry
// point for every authFetch catch site that used to call
// showToast(err.message) directly, routes a caught error to the themed
// #modal-error-dialog (built on the same .modal-overlay/.modal-box shell
// as the Group 2/3 confirm dialog, 9873868) when it's long or carries a
// structured `details` array, and to the plain toast otherwise — so a
// short error ("Invalid email or password") keeps behaving exactly as
// before.
//
// This test proves both real end-to-end paths, not just that the two
// helper functions exist:
//  1. A genuinely short, single-string server error (a real login
//     rejection) still surfaces as a toast, not a dialog.
//  2. A genuine multi-reason `details` array (two malformed {{...}}
//     placeholders in one template body — templateParams.js's
//     malformedPlaceholderErrors, one entry per placeholder) opens the
//     dialog, renders as a real <ul>/<li> list (not extractApiErrorDetail's
//     join(' '), which was losing structure), and its Copy button copies
//     the same text a support case would need.
//
// The malformed-placeholder body is set via page.evaluate directly on the
// textarea's `.value`, bypassing the 'input' event on purpose — the
// Create Template modal's own live "flag while typing" validation
// (templateParams.js, loaded client-side) would otherwise disable Submit
// before this rule ever reaches the server, which is correct product
// behavior but would make the server's `details`-array response
// unreachable through a normal fill(). This deliberately exercises what a
// user hitting Submit on stale/cached form state (or a future validation
// gap) would see — the server-truth path this dialog exists for.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.ALLOWED_ORIGINS = 'http://localhost:4000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server, baseUrl, browser;

const SUITE_PREFIX = '__test_suite__errordialog_';
const EMAIL = `test-suite-errordialog-${Date.now()}@wasi.local`;
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
  await pool.query('delete from clients where email = $1', [EMAIL]).catch(() => {});
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

test('a short, real server error (wrong password) stays a toast, not the error dialog', async () => {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(`${baseUrl}/`);
  await page.waitForTimeout(500);

  await page.fill('#login-email', EMAIL);
  await page.fill('#login-password', 'definitely-the-wrong-password');
  await page.click('#login-form button[type="submit"]');

  const toast = page.locator('.toast').first();
  await assert.doesNotReject(() => toast.waitFor({ state: 'attached', timeout: 3000 }));
  assert.equal(await toast.textContent(), 'Invalid email or password');

  // .modal-overlay only ever toggles opacity/pointer-events via .open
  // (index.css), never display:none — confirm the dialog's .open class was
  // never added, not just that it "looks" hidden.
  const dialogOpened = await page.evaluate(() => document.getElementById('modal-error-dialog').classList.contains('open'));
  assert.equal(dialogOpened, false, 'a short, unstructured error must not open the error dialog');

  await page.close();
});

test('a real multi-reason `details` array (2 malformed template placeholders) opens the error dialog as a list, with a working Copy button', async () => {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  const page = await context.newPage();
  await login(page);

  await page.click('.nav-item[data-view="template"]');
  await page.waitForTimeout(300);
  await page.click('#open-create-template-modal');
  await page.waitForSelector('#modal-create-template.open', { timeout: 3000 });

  await page.fill('#new-template-name', `${SUITE_PREFIX}tpl`);
  // A valid, param-free body first — real behavior, needed so the live
  // "flag while typing" validation actually enables Submit before it gets
  // overwritten below.
  await page.fill('#new-template-body', 'Thank you for choosing us for your recent purchase, we appreciate your business.');
  await page.waitForTimeout(200);
  const submitBtn = page.locator('#create-template-form button[type="submit"]');
  assert.equal(await submitBtn.isDisabled(), false, 'a valid body must leave Submit enabled before the bypass below');

  // Two distinct malformed placeholders — findMalformedPlaceholders
  // (templateParams.js) flags each one separately, so this produces a real
  // 2-entry details array in one request. Set directly on .value, no
  // 'input' dispatch — see the file header comment for why.
  await page.evaluate(() => {
    document.getElementById('new-template-body').value =
      'Hi {{Customer}}, your order {{Order ID}} has shipped and is on its way to you right now.';
  });
  await submitBtn.click();

  await page.waitForSelector('#modal-error-dialog.open', { timeout: 3000 });
  assert.equal(await page.locator('#modal-error-dialog-title').textContent(), 'Invalid template body');

  const items = page.locator('#modal-error-dialog-body ul li');
  assert.equal(await items.count(), 2, 'both malformed placeholders must each get their own list item, not one joined paragraph');
  const itemTexts = await items.allTextContents();
  assert.ok(itemTexts.some((t) => t.includes('{{Customer}}')), 'the first malformed placeholder must be named');
  assert.ok(itemTexts.some((t) => t.includes('{{Order ID}}')), 'the second malformed placeholder must be named');

  await page.click('#modal-error-dialog-copy-btn');
  await page.waitForFunction(() => document.getElementById('modal-error-dialog-copy-btn').textContent === 'Copied!', { timeout: 3000 });
  // Windows' clipboard normalizes bare \n to \r\n on write — an OS/platform
  // quirk of this test environment, not app behavior — so compare with
  // line endings normalized rather than asserting exact bytes.
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clipboardText.replace(/\r\n/g, '\n'), itemTexts.join('\n'), 'Copy must place the exact same reasons on the clipboard as are shown in the list');

  await page.click('#modal-error-dialog button[data-close-modal="modal-error-dialog"]:has-text("Close")');
  await page.waitForFunction(() => !document.getElementById('modal-error-dialog').classList.contains('open'), { timeout: 3000 });

  await page.close();
  await context.close();
});
