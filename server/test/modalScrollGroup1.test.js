// UI/UX consistency pass, Group 1 — .modal-box's max-height/overflow-y used
// to live ONLY inside @media(max-width:640px), so any modal taller than the
// viewport had no scroll mechanism at all above 640px — including 900px
// tablet and 1366x768 desktop, confirmed via a real screenshot to be the
// actual reported bug ("New Campaign doesn't scroll, content below Smart
// Sending is unreachable"). Fixed by moving max-height:88vh/overflow-y:auto
// into the base .modal-box rule (index.css) so it applies at every width,
// not just narrow ones. This test proves the fix at 1366x768 (where it was
// broken) AND at a mobile width (where it already worked, as a regression
// guard) — New Campaign (#modal-create-campaign) is the real modal that was
// reported, so it's the one exercised here rather than a synthetic one.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.ALLOWED_ORIGINS = 'http://localhost:4000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server, baseUrl, browser;

const SUITE_PREFIX = '__test_suite__modalscroll1_';
const EMAIL = `test-suite-modalscroll1-${Date.now()}@wasi.local`;
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
  });

  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// Logs in via the real UI and opens the New Campaign modal, returning the
// page ready for assertions. Shared by both viewport checks below so the
// only difference between them is the viewport itself.
async function openNewCampaignModal(viewport) {
  const page = await browser.newPage({ viewport });
  await page.goto(`${baseUrl}/`);
  await page.fill('#login-email', EMAIL);
  await page.fill('#login-password', PASSWORD);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('#app-shell:not([style*="display: none"])', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // Mobile widths hide the sidebar behind a hamburger toggle — matches the
  // established .mobile-sidebar-toggle pattern (see breakpoints.css).
  const mobileToggle = page.locator('#mobile-sidebar-toggle-btn');
  if (await mobileToggle.isVisible().catch(() => false)) {
    await mobileToggle.click();
    await page.waitForTimeout(300);
  }
  await page.click('.nav-item[data-view="campaigns"]');
  await page.waitForTimeout(500);
  await page.click('#open-create-broadcast-modal');
  await page.waitForSelector('#modal-create-campaign.open', { timeout: 5000 });
  await page.waitForTimeout(300);
  return page;
}

test('1366x768: .modal-box scrolls internally, and Launch Campaign (below Smart Sending) is reachable', async () => {
  const page = await openNewCampaignModal({ width: 1366, height: 768 });

  const modalBox = page.locator('#modal-create-campaign .modal-box');
  const overflowY = await modalBox.evaluate((el) => getComputedStyle(el).overflowY);
  assert.equal(overflowY, 'auto', '.modal-box must have overflow-y:auto at 1366x768, not just below 640px');

  const { scrollHeight, clientHeight } = await modalBox.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  assert.ok(
    scrollHeight > clientHeight,
    `New Campaign's real content must overflow .modal-box's capped height at 1366x768 (scrollHeight ${scrollHeight} vs clientHeight ${clientHeight}) — otherwise this test isn't exercising the scroll mechanism at all`
  );

  const launchBtn = page.locator('#modal-create-campaign button[type="submit"]');
  await launchBtn.scrollIntoViewIfNeeded();
  const box = await launchBtn.boundingBox();
  assert.ok(box, 'Launch Campaign button must be attached and have a real bounding box');
  assert.ok(
    box.y >= 0 && box.y + box.height <= 768,
    `Launch Campaign must be scrolled into the actual visible viewport at 1366x768, not just scrollable-to in theory (box.y=${box.y}, height=${box.height})`
  );

  await page.close();
});

test('375x812 mobile: same modal still scrolls correctly (regression guard — this width already worked before the fix)', async () => {
  const page = await openNewCampaignModal({ width: 375, height: 812 });

  const modalBox = page.locator('#modal-create-campaign .modal-box');
  const overflowY = await modalBox.evaluate((el) => getComputedStyle(el).overflowY);
  assert.equal(overflowY, 'auto');

  const launchBtn = page.locator('#modal-create-campaign button[type="submit"]');
  await launchBtn.scrollIntoViewIfNeeded();
  const box = await launchBtn.boundingBox();
  assert.ok(box, 'Launch Campaign button must be attached and have a real bounding box');
  assert.ok(
    box.y >= 0 && box.y + box.height <= 812,
    `Launch Campaign must be reachable at mobile width too (box.y=${box.y}, height=${box.height})`
  );

  await page.close();
});
