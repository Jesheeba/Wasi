// Real-browser coverage for the Template Library's frontend behavior
// (index.html's #view-template-library, app.js's Template Library section)
// — the filter/browse UI and the "Use this Template" prefill flow, which
// have no server-side equivalent to test via a plain HTTP request. This is
// the first Playwright-based test in server/test/ (every other file drives
// the app via plain fetch()) — `playwright` is a real, already-declared
// dependency (repo-root package.json), used for real ad-hoc verification of
// this same feature and the project's mobile-responsiveness work before
// this file existed; this formalizes that same approach as a permanent,
// re-runnable regression test instead of a one-off throwaway script.
//
// Same dedicated-disposable-test-client convention as every other file in
// this directory: a real client via /api/auth/register, deleted in
// after(). Runs against the real seeded template_library content (36 rows)
// — this IS the same content real clients see, not a fixture.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
// Default ALLOWED_ORIGINS only lists :3000 (app.js's own comment: the
// split-origin local-dev setup) — binding this suite's server to :4000
// (below, matching app.js's own API_BASE same-origin branch) means the
// browser's own same-origin fetch()es still send an Origin header
// Chromium doesn't omit, so :4000 needs allowlisting for this one suite.
process.env.ALLOWED_ORIGINS = 'http://localhost:4000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let browser;
let page;
let baseUrl;
let testClientId;

const SUITE_PREFIX = '__test_suite__templatelibraryui_';
const EMAIL = `test-suite-templatelibraryui-${Date.now()}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';

// Playwright's selectOption() drives a real synthetic mouse interaction and
// polls its own actionability checks (visible/stable/receives-events) —
// against this app, that polling proved unreliable under real backend
// latency (confirmed by direct DOM inspection at the exact failure point:
// getComputedStyle/getBoundingClientRect/elementFromPoint all agreed the
// element was fully visible, unobscured, and correctly targeted, yet
// selectOption still timed out waiting for its own internal check to agree)
// — a known category of flakiness with <select> actionability polling, not
// an application bug. Setting the value directly and dispatching the same
// 'change' event a real user's selection would fire exercises the exact
// application code path (renderLibraryGrid's change-listener) that matters
// for a regression test, without depending on Playwright's synthetic-click
// polling agreeing with itself.
async function setFilter(id, value) {
  await page.evaluate(({ id, value }) => {
    const el = document.getElementById(id);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { id, value });
}

before(async () => {
  const app = createApp();
  // The root app's app.js picks its API_BASE based on the page's own
  // origin/port (split-origin local-dev convention: same-origin unless on
  // localhost and NOT already port 4000) — binding here to 4000 keeps
  // every fetch() same-origin, matching how the app actually runs in both
  // local dev and production (one process serving both static files and
  // the API), rather than needing a second server. See app.js's own
  // API_BASE comment.
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
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // Surfaces a silent client-side JS exception as loud test output instead
  // of a confusing downstream "element not visible" timeout.
  page.on('pageerror', (err) => console.error('[browser pageerror]', err.message));
  await page.goto(`${baseUrl}/index.html`);
  await page.fill('#login-email', EMAIL);
  await page.fill('#login-password', PASSWORD);
  await page.click('#login-form button[type="submit"]');
  // Explicit wait, not a selector-visibility auto-wait: the nav sidebar
  // lives inside #app-shell, which only becomes visible after login's own
  // async fetch + state update settles — waiting on the nav item's
  // visibility directly proved unreliable (intermittently resolved before
  // the shell's display actually flipped), so this waits for the real
  // signal instead.
  await page.waitForTimeout(1500);
  const loggedIn = await page.evaluate(() => getComputedStyle(document.getElementById('app-shell')).display !== 'none');
  assert.ok(loggedIn, 'login must complete and #app-shell become visible before any test runs');

  await page.click('[data-view="template-library"]');
  await page.waitForSelector('#library-grid .library-template-card', { timeout: 10000 });
});

after(async () => {
  await browser?.close();
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('browsing to Template Library renders all 36 real seeded cards', async () => {
  const count = await page.$$eval('#library-grid .library-template-card', (els) => els.length);
  assert.ok(count >= 36, `expected at least 36 rendered cards, got ${count}`);
});

test('the industry filter dropdown is populated from real data and actually filters the rendered grid', async () => {
  const options = await page.$$eval('#library-filter-industry option', (els) => els.map((o) => o.value).filter(Boolean));
  assert.ok(options.includes('Healthcare'));
  assert.ok(options.includes('E-commerce'));
  assert.ok(options.includes('General/Other'));

  await setFilter('library-filter-industry', 'Healthcare');
  const cards = await page.$$eval('#library-grid .library-template-card', (els) =>
    els.map((el) => el.querySelector('div:last-child')?.textContent || '')
  );
  assert.ok(cards.length >= 12);
  assert.ok(cards.every((t) => t.includes('Healthcare')), 'every rendered card must be Healthcare after filtering');

  await setFilter('library-filter-industry', '');
});

test('the category filter narrows to Authentication-only cards, each showing the AUTHENTICATION badge', async () => {
  await setFilter('library-filter-category', 'Authentication');
  const badges = await page.$$eval('#library-grid .library-template-card .template-badge', (els) => els.map((e) => e.textContent));
  assert.ok(badges.length >= 2);
  assert.ok(badges.every((b) => b === 'Authentication'));
  await setFilter('library-filter-category', '');
});

test('combining industry + use_case filters narrows the grid to exactly one card', async () => {
  await setFilter('library-filter-industry', 'E-commerce');
  await setFilter('library-filter-use-case', 'abandoned_cart');
  const count = await page.$$eval('#library-grid .library-template-card', (els) => els.length);
  assert.equal(count, 1);
  const title = await page.$eval('#library-grid .library-template-card', (el) => el.querySelector('span').textContent);
  assert.equal(title, 'Abandoned Cart Reminder');
});

test('selecting a card renders its live WhatsApp-style preview with real substituted sample values', async () => {
  await page.click('#library-grid .library-template-card');
  await page.waitForSelector('#library-preview-bubble', { timeout: 5000 });
  const previewText = await page.$eval('#library-preview-bubble', (el) => el.textContent);
  assert.match(previewText, /Priya/, 'sample value must be substituted into the preview, not left as {{customer_name}}');
  assert.doesNotMatch(previewText, /\{\{/, 'no raw {{placeholder}} syntax should remain in a rendered preview');

  const selectedCard = await page.$('#library-grid .library-template-card.selected');
  assert.ok(selectedCard, 'clicking a card must visually mark it selected');
});

test('"Use This Template" opens the real Create Template modal, prefilled exactly from the library entry, and records usage server-side', async () => {
  const beforeUsage = await pool.query(
    `select count(*)::int as n from template_library_usage tlu join clients c on c.id = tlu.client_id where c.id = $1`,
    [testClientId]
  );

  await page.click('#use-library-template-btn');
  await page.waitForSelector('#modal-create-template.open', { timeout: 5000 });

  const modalState = await page.evaluate(() => ({
    view: document.getElementById('view-template')?.classList.contains('active'),
    name: document.getElementById('new-template-name').value,
    category: document.getElementById('new-template-category').value,
    headerText: document.getElementById('new-template-header-text').value,
    body: document.getElementById('new-template-body').value,
    footer: document.getElementById('new-template-footer').value,
    samples: Array.from(document.querySelectorAll('#template-sample-values-list [data-param-name]')).map((el) => [el.dataset.paramName, el.value]),
    buttonCount: document.querySelectorAll('#template-buttons-list .template-button-row').length,
  }));

  assert.equal(modalState.view, true, 'switching to the modal must land the underlying view on Templates');
  assert.equal(modalState.name, 'abandoned_cart_reminder');
  assert.equal(modalState.category, 'Marketing');
  assert.equal(modalState.headerText, 'Still thinking it over?');
  assert.equal(modalState.body, 'Hi {{customer_name}}, you left {{item_name}} in your cart. Complete your purchase now before it sells out.');
  assert.match(modalState.body, /\{\{customer_name\}\}/, 'the FORM FIELD must keep the raw {{placeholder}}, unlike the preview bubble — this is what actually gets submitted');
  assert.equal(modalState.footer, 'Reply STOP to unsubscribe');
  assert.deepEqual(Object.fromEntries(modalState.samples), { customer_name: 'Priya', item_name: 'Wireless Earbuds' });
  assert.equal(modalState.buttonCount, 1);

  await page.waitForTimeout(500); // give the (awaited server-side, but not test-observed) usage POST time to land
  const afterUsage = await pool.query(
    `select count(*)::int as n from template_library_usage tlu join clients c on c.id = tlu.client_id where c.id = $1`,
    [testClientId]
  );
  assert.equal(afterUsage.rows[0].n, beforeUsage.rows[0].n + 1, 'exactly one new usage row must be recorded for this client');

  await page.click('#modal-create-template .close-modal-btn');
});

test('Authentication entries do not prefill body/header/footer/buttons — only category, matching the schema\'s own rule', async () => {
  // The previous test's "Use This Template" click navigated the underlying
  // view to Templates (switchView('template') inside useTemplateFromLibrary)
  // before opening the modal on top of it — closing that modal leaves us on
  // Templates, not Template Library, so the library's own filter controls
  // are inactive/hidden until we navigate back.
  await page.click('[data-view="template-library"]');
  await page.waitForSelector('#library-grid .library-template-card', { timeout: 10000 });

  await setFilter('library-filter-industry', '');
  await setFilter('library-filter-use-case', '');
  await setFilter('library-filter-category', 'Authentication');

  await page.click('#library-grid .library-template-card');
  await page.waitForSelector('#use-library-template-btn', { timeout: 5000 });
  await page.click('#use-library-template-btn');
  await page.waitForSelector('#modal-create-template.open', { timeout: 5000 });

  const state = await page.evaluate(() => ({
    category: document.getElementById('new-template-category').value,
    body: document.getElementById('new-template-body').value,
    footer: document.getElementById('new-template-footer').value,
    authFieldsVisible: document.getElementById('template-fields-auth')?.style.display !== 'none',
    standardFieldsHidden: document.getElementById('template-fields-standard')?.style.display === 'none',
  }));
  assert.equal(state.category, 'Authentication');
  assert.equal(state.body, '', 'Authentication prefill must not populate body — messageTemplateCreateSchema rejects it for this category');
  assert.equal(state.footer, '');
  assert.equal(state.authFieldsVisible, true, 'the modal\'s own Authentication-specific fields must take over, matching how a manually-authored Authentication template already works');
  assert.equal(state.standardFieldsHidden, true);

  await page.click('#modal-create-template .close-modal-btn');
  await setFilter('library-filter-category', '');
});

test('the Template Library view renders with no horizontal overflow at 375px (mobile)', async () => {
  const mobilePage = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await mobilePage.goto(`${baseUrl}/index.html`);
  await mobilePage.fill('#login-email', EMAIL);
  await mobilePage.fill('#login-password', PASSWORD);
  await mobilePage.click('#login-form button[type="submit"]');
  await mobilePage.waitForTimeout(1500);

  const toggle = await mobilePage.$('#mobile-sidebar-toggle-btn');
  if (toggle) await toggle.click();
  await mobilePage.waitForTimeout(300);
  await mobilePage.click('[data-view="template-library"]');
  await mobilePage.waitForSelector('#library-grid .library-template-card', { timeout: 10000 });

  const overflow = await mobilePage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert.equal(overflow.scrollWidth, overflow.clientWidth, 'no horizontal overflow should exist at 375px width');

  await mobilePage.close();
});
