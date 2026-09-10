// UI/UX consistency pass, Group 4 — 3 modals each hardcoded their own
// literal inline max-height for a bounded-height region NESTED inside an
// already-scrolling .modal-box (a contact search results list, a template
// picker list, an activity timeline): 220px, 260px, 280px, three one-off
// copies of the identical overflow-y:auto mechanism. Replaced with one
// shared .modal-inner-scroll class (default 260px) plus a
// --modal-inner-scroll-height CSS variable escape hatch for the two call
// sites that want a different height. This test proves all 3 elements
// resolve to their real, DISTINCT computed max-height (proving the
// variable override genuinely takes effect, not just that a class name is
// present) at 1366x768 and a mobile width.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.ALLOWED_ORIGINS = 'http://localhost:4000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server, baseUrl, browser;

const SUITE_PREFIX = '__test_suite__modalinnerscroll4_';
const EMAIL = `test-suite-modalinnerscroll4-${Date.now()}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

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
  const token = registered.token;

  // One real contact so a Contacts-view row exists to click into the
  // contact-detail modal (whose Activity timeline is one of the 3 regions).
  await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: authed(token),
    body: JSON.stringify({ name: 'Group4 Test Contact', phone: '919000000004' }),
  });

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

async function assertInnerScroll(locator, expectedMaxHeightPx) {
  assert.ok(await locator.evaluate((el) => el.classList.contains('modal-inner-scroll')));
  const { overflowY, maxHeight } = await locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { overflowY: cs.overflowY, maxHeight: cs.maxHeight };
  });
  assert.equal(overflowY, 'auto');
  assert.equal(maxHeight, `${expectedMaxHeightPx}px`, `expected the real resolved max-height to be ${expectedMaxHeightPx}px`);
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 375, height: 812 }]) {
  const label = `${viewport.width}x${viewport.height}`;

  test(`${label}: contact-detail's Activity timeline uses the shared class at its 260px default`, async () => {
    const page = await browser.newPage({ viewport });
    await login(page);

    await page.click('.nav-item[data-view="contacts"]');
    await page.waitForTimeout(800);
    await page.click('#contacts-table-body tr');
    await page.waitForSelector('#modal-contact-detail.open', { timeout: 5000 });
    await page.waitForTimeout(300);

    await assertInnerScroll(page.locator('#contact-detail-timeline'), 260);
    await page.close();
  });

  test(`${label}: new-conversation's contact-results and template-list resolve to their real, DISTINCT overridden heights (220px, 280px)`, async () => {
    const page = await browser.newPage({ viewport });
    await login(page);

    await page.click('.nav-item[data-view="chat"]');
    await page.waitForTimeout(800);
    // Opened directly rather than via the real trigger button: at mobile
    // widths the fixed-position hamburger toggle overlaps both
    // #new-conversation-trigger and #start-new-chat-btn (a real, separate,
    // pre-existing layout bug in the Chat view — same class as CLAUDE.md's
    // documented .page-title-bar overlap, not something Group 4 is scoped
    // to fix). What this test actually checks is the inner-scroll CSS
    // resolution once the modal is open, not the click-to-open interaction
    // chain (Group 1's test already covers that pattern for a different
    // modal), so opening it directly is a more targeted isolation, not a
    // weaker test.
    await page.evaluate(() => document.getElementById('modal-new-conversation').classList.add('open'));
    await page.waitForTimeout(300);

    // Both elements exist in the DOM once the modal opens, regardless of
    // which step is currently visible — checking computed style doesn't
    // require them to be shown, only that the CSS variable resolved.
    await assertInnerScroll(page.locator('#new-conversation-contact-results'), 220);
    await assertInnerScroll(page.locator('#new-conversation-template-list'), 280);

    await page.close();
  });
}
