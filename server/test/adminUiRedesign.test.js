// Admin console redesign (UI redesign Stage 11). Proves the structural/behavioral
// changes in a real browser against the real admin app:
//  1. the sidebar renders in labelled groups and still exposes every view
//  2. the pre-redesign hash routes (#health-monitor, #waba-health,
//     #platform-overview, #failures, #volume) still resolve — to the merged
//     Health / Statistics views and the right tab
//  3. a refresh / deep link on #client-detail/<id> lands on that client (it used
//     to always land on the dashboard), keeping the selected tab
//  4. Client Detail is tabbed, and the tabs switch (and update the URL)
//  5. Templates Review asks for confirmation (showing the template body) before
//     Approve/Reject, and a FAILED confirm keeps the dialog open with the error
//  6. Delete Client needs the client's exact name typed before it enables
//  7. "Send reminder to all active clients" previews the recipients — it is
//     cancelled here, never confirmed, so nothing is ever sent
//
// Everything runs against a disposable client (created through the real admin
// API, deleted in after()); no WhatsApp message is sent and Meta is never called.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.ALLOWED_ORIGINS = 'http://localhost:4000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server, baseUrl, browser, adminToken, adminProfile;
let clientId, clientName, templateId;

const SUITE_PREFIX = '__test_suite__adminui_';
const TEMPLATE_BODY = 'Hello {{name}}, your admin-ui redesign test order has shipped.';

before(async () => {
  server = createApp().listen(4000);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = 'http://localhost:4000';

  const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@wasi.local', password: 'admin12345' }),
  }).then((r) => r.json());
  adminToken = login.token;
  adminProfile = login.admin;
  assert.ok(adminToken, 'seeded demo admin must be able to sign in');

  clientName = `${SUITE_PREFIX}client ${Date.now()}`;
  const created = await fetch(`${baseUrl}/api/clients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: clientName, email: `test-suite-adminui-${Date.now()}@wasi.local` }),
  }).then((r) => r.json());
  clientId = created.id;
  assert.ok(clientId, 'disposable client must be created');

  const { rows } = await pool.query(
    `insert into message_templates (client_id, name, category, body, status, language)
     values ($1, $2, 'Utility', $3, 'pending', 'en') returning id`,
    [clientId, `${SUITE_PREFIX}tpl`, TEMPLATE_BODY]
  );
  templateId = rows[0].id;

  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  if (clientId) {
    await pool.query('delete from clients where id = $1', [clientId]).catch(() => {});
    // audit_log.target / actor_id have no FK to clients, so the cascade above
    // never cleans these — remove exactly this client's rows.
    await pool.query(`delete from audit_log where target like $1 or actor_id::text = $2`, [`%${clientId}%`, clientId]).catch(() => {});
  }
  await pool.end();
});

// POST /api/admin/auth/login is rate-limited to 5 per 15 minutes (adminLoginLimiter),
// so only `ui: true` goes through the real login form; every other page restores
// the session the same way a returning admin's browser does — from localStorage.
async function openAdmin(viewport = { width: 1366, height: 800 }, hash = '', { ui = false } = {}) {
  const context = await browser.newContext({ viewport });
  if (!ui) {
    await context.addInitScript(([t, p]) => {
      localStorage.setItem('admin_token', t);
      localStorage.setItem('admin_profile', p);
    }, [adminToken, JSON.stringify(adminProfile)]);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${baseUrl}/admin/${hash}`);
  if (ui) {
    await page.fill('#login-email', 'admin@wasi.local');
    await page.fill('#login-password', 'admin12345');
    await page.click('#login-form button[type="submit"]');
  }
  await page.waitForSelector('#app-shell', { state: 'visible', timeout: 5000 });
  page.errors = errors;
  return page;
}

const activeView = (page) => page.evaluate(() => document.querySelector('.admin-view.active')?.id);
const selectedTab = (page, viewId) =>
  page.evaluate((id) => document.querySelector(`#${id} [role="tab"][aria-selected="true"]`)?.getAttribute('data-tab'), viewId);

test('sidebar is grouped (Overview / Clients / Operations / Platform) and keeps every view reachable', async () => {
  const page = await openAdmin({ width: 1366, height: 800 }, '', { ui: true });
  const labels = await page.$$eval('#sidebar .nav-group-label', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(labels, ['Overview', 'Clients', 'Operations', 'Platform']);

  const views = await page.$$eval('#sidebar .nav-item[data-view]', (els) => els.map((e) => e.getAttribute('data-view')));
  assert.deepEqual(views, [
    'dashboard', 'statistics', 'health',
    'clients', 'onboarding',
    'templates-review', 'tickets', 'payment-reminders', 'billing',
    'api-keys', 'api-guide', 'team', 'audit-log', 'settings',
  ]);

  // Every nav item opens its own view.
  for (const v of views) {
    await page.click(`#sidebar .nav-item[data-view="${v}"]`);
    assert.equal(await activeView(page), `view-${v}`, `nav item ${v} must open view-${v}`);
  }
  assert.deepEqual(page.errors, [], 'no uncaught page errors while visiting every view');
  await page.context().close();
});

test('old hash routes resolve to the merged Health / Statistics views and the right tab', async () => {
  const page = await openAdmin();
  const cases = [
    ['#health-monitor', 'view-health', 'monitor'],
    ['#waba-health', 'view-health', 'waba'],
    ['#platform-overview', 'view-health', 'overview'],
    ['#failures', 'view-health', 'failures'],
    ['#volume', 'view-statistics', 'volume'],
    ['#statistics', 'view-statistics', 'trends'],
    ['#health', 'view-health', 'monitor'],
  ];
  for (const [hash, view, tab] of cases) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForFunction((v) => document.querySelector('.admin-view.active')?.id === v, view, { timeout: 3000 });
    assert.equal(await selectedTab(page, view), tab, `${hash} must select the ${tab} tab`);
    const panelShown = await page.evaluate((t) => !document.querySelector(`[data-panel="${t}"]`).hidden, tab);
    assert.equal(panelShown, true, `${hash}: the ${tab} panel must be visible`);
  }
  await page.context().close();
});

test('a refresh on #client-detail/<id> stays on that client and keeps its tab (used to land on the dashboard)', async () => {
  const page = await openAdmin({ width: 1366, height: 800 }, `#client-detail/${clientId}?tab=billing`);
  // The login happened with the deep link already in the URL.
  await page.waitForSelector('#client-detail-content h1', { timeout: 5000 });
  assert.equal(await activeView(page), 'view-client-detail');
  assert.match(await page.locator('#client-detail-content h1').textContent(), new RegExp(SUITE_PREFIX));
  assert.equal(await selectedTab(page, 'client-detail-content'), 'billing');

  await page.reload();
  await page.waitForSelector('#client-detail-content h1', { timeout: 5000 });
  assert.equal(await activeView(page), 'view-client-detail', 'reload must not bounce to the dashboard');
  assert.equal(await selectedTab(page, 'client-detail-content'), 'billing', 'reload must keep the selected tab');
  assert.match(await page.evaluate(() => location.hash), new RegExp(`^#client-detail/${clientId}`));
  await page.context().close();
});

test('Client Detail tabs switch panels and the URL; Delete Client lives in the Overview danger zone', async () => {
  const page = await openAdmin({ width: 1366, height: 800 }, `#client-detail/${clientId}`);
  await page.waitForSelector('#client-detail-content h1');

  const tabs = await page.$$eval('#client-detail-content [role="tab"]', (els) => els.map((e) => e.getAttribute('data-tab')));
  assert.deepEqual(tabs, ['overview', 'billing', 'whatsapp', 'templates', 'activity']);

  for (const tab of ['billing', 'whatsapp', 'templates', 'activity', 'overview']) {
    await page.click(`#tab-client-${tab}`);
    assert.equal(await selectedTab(page, 'client-detail-content'), tab);
    const visiblePanels = await page.$$eval('#client-detail-content [role="tabpanel"]', (els) => els.filter((e) => !e.hidden).map((e) => e.getAttribute('data-panel')));
    assert.deepEqual(visiblePanels, [tab], 'exactly the selected tab panel is shown');
    const hash = await page.evaluate(() => location.hash);
    if (tab === 'overview') assert.equal(hash, `#client-detail/${clientId}`);
    else assert.equal(hash, `#client-detail/${clientId}?tab=${tab}`);
  }

  // Keyboard: arrow keys move between tabs.
  await page.focus('#tab-client-overview');
  await page.keyboard.press('ArrowRight');
  assert.equal(await selectedTab(page, 'client-detail-content'), 'billing');

  // Service/Payment controls moved to Billing & Service; WABA to WhatsApp.
  assert.equal(await page.locator('#panel-client-billing #service-toggle').count(), 1);
  assert.equal(await page.locator('#panel-client-billing #payment-toggle').count(), 1);
  assert.equal(await page.locator('#panel-client-overview #delete-client-btn').count(), 1);
  assert.equal(await page.locator('#panel-client-overview #status-editor-select').count(), 1);
  await page.context().close();
});

test('Delete Client needs the exact client name typed before the confirm button enables (never confirmed here)', async () => {
  const page = await openAdmin({ width: 1366, height: 800 }, `#client-detail/${clientId}`);
  await page.waitForSelector('#delete-client-btn');
  await page.click('#delete-client-btn');
  await page.waitForSelector('#confirm-modal.open');

  const action = page.locator('#confirm-modal-action-btn');
  assert.equal(await action.isDisabled(), true, 'disabled until the name is typed');
  assert.equal(await page.locator('#confirm-modal-require').isVisible(), true);

  await page.fill('#confirm-modal-require-input', clientName.slice(0, -2));
  assert.equal(await action.isDisabled(), true, 'a partial name must not enable it');
  await page.fill('#confirm-modal-require-input', clientName);
  assert.equal(await action.isDisabled(), false, 'the exact name enables it');

  // Cancel — the client must still exist.
  await page.click('#confirm-modal .modal-actions .btn-secondary');
  await page.waitForFunction(() => !document.getElementById('confirm-modal').classList.contains('open'));
  const { rows } = await pool.query('select 1 from clients where id = $1', [clientId]);
  assert.equal(rows.length, 1, 'cancelling must not delete the client');
  await page.context().close();
});

test('Templates Review: Approve asks first, shows the body, and a failed confirm keeps the dialog open with the error', async () => {
  const page = await openAdmin({ width: 1366, height: 800 }, '#templates-review');
  await page.waitForSelector('#templates-review-table-body tr[data-template-id]');
  await page.fill('#templates-review-search', `${SUITE_PREFIX}tpl`);
  const row = page.locator(`#templates-review-table-body tr[data-template-id="${templateId}"]`);
  await row.waitFor();

  // Clicking Approve opens a confirm — it does NOT approve straight away.
  await row.locator('[data-template-action="approved"]').click();
  await page.waitForSelector('#confirm-modal.open');
  assert.match(await page.locator('#confirm-modal-title').textContent(), /Approve this template/);
  assert.match(await page.locator('#confirm-modal-body').textContent(), /admin-ui redesign test order has shipped/, 'the confirm shows the full template body');
  const statusBefore = (await pool.query('select status from message_templates where id = $1', [templateId])).rows[0].status;
  assert.equal(statusBefore, 'pending', 'opening the confirm must not change the status');

  // Make the PATCH fail: the dialog must stay open and show the error inline.
  await page.route(`**/api/admin/templates/${templateId}`, (route) => route.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated server failure' }),
  }));
  await page.click('#confirm-modal-action-btn');
  await page.waitForSelector('#confirm-modal-error:not([hidden])');
  assert.match(await page.locator('#confirm-modal-error').textContent(), /Simulated server failure/);
  assert.equal(await page.evaluate(() => document.getElementById('confirm-modal').classList.contains('open')), true, 'a failed action must NOT close the dialog');
  assert.equal(await page.locator('#confirm-modal-action-btn').isDisabled(), false, 'the admin can retry');
  await page.unroute(`**/api/admin/templates/${templateId}`);

  // Cancel — status still pending.
  await page.click('#confirm-modal .modal-actions .btn-secondary');
  const statusAfter = (await pool.query('select status from message_templates where id = $1', [templateId])).rows[0].status;
  assert.equal(statusAfter, 'pending');

  // "View" opens the full-body modal.
  await row.locator('[data-template-view]').click();
  await page.waitForSelector('#template-review-modal.open');
  assert.match(await page.locator('#template-review-body').textContent(), /admin-ui redesign test order has shipped/);
  await page.context().close();
});

test('Payment Reminders: "send to all active" previews the recipients; cancelling sends nothing', async () => {
  const page = await openAdmin({ width: 1366, height: 800 }, '#payment-reminders');
  await page.waitForSelector('#pr-send-all-btn');
  const sendCalls = [];
  page.on('request', (req) => { if (req.url().includes('/send-reminders')) sendCalls.push(req.url()); });

  await page.click('#pr-send-all-btn');
  await page.waitForSelector('#confirm-modal.open');
  const title = await page.locator('#confirm-modal-title').textContent();
  assert.match(title, /Send payment reminder to \d+ active client/);
  // The preview lists real recipients (the seeded demo client is active).
  assert.match(await page.locator('#confirm-modal-body .recipient-list').textContent(), /demo@wasi\.local/);

  await page.click('#confirm-modal .modal-actions .btn-secondary');
  await page.waitForFunction(() => !document.getElementById('confirm-modal').classList.contains('open'));
  assert.deepEqual(sendCalls, [], 'cancelling must never call the send endpoint');
  await page.context().close();
});

test('Create Client: credentials have copy buttons and the modal cannot be dismissed until acknowledged', async () => {
  const page = await openAdmin({ width: 1366, height: 800 }, '#clients');
  const email = `test-suite-adminui-create-${Date.now()}@wasi.local`;
  const name = `${SUITE_PREFIX}created ${Date.now()}`;
  await page.waitForSelector('#open-create-client-btn');
  await page.click('#open-create-client-btn');
  await page.fill('#create-client-name', name);
  await page.fill('#create-client-email', email);
  await page.click('#create-client-submit-btn');
  await page.waitForSelector('#create-client-result .secret-row');

  try {
    assert.equal(await page.locator('#create-client-result .secret-row').count(), 4, 'login URL, email, password and API key each get a row');
    assert.equal(await page.locator('#create-client-result .secret-row [data-copy-value-target]').count(), 4, 'each credential has its own copy button');
    assert.equal(await page.locator('#create-client-done-btn').isDisabled(), true);

    // Closing (X button, then Escape) is refused while the credentials are unacknowledged.
    await page.click('#create-client-modal .close-modal-btn');
    assert.equal(await page.evaluate(() => document.getElementById('create-client-modal').classList.contains('open')), true, 'X must not dismiss unacknowledged credentials');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.getElementById('create-client-modal').classList.contains('open')), true, 'Escape must not dismiss unacknowledged credentials');

    await page.check('#create-client-ack');
    assert.equal(await page.locator('#create-client-done-btn').isDisabled(), false);
    await page.click('#create-client-done-btn');
    await page.waitForFunction(() => !document.getElementById('create-client-modal').classList.contains('open'));
  } finally {
    const { rows } = await pool.query('select id from clients where email = $1', [email]);
    for (const r of rows) {
      await pool.query('delete from clients where id = $1', [r.id]).catch(() => {});
      await pool.query(`delete from audit_log where target like $1 or actor_id::text = $2`, [`%${r.id}%`, r.id]).catch(() => {});
    }
  }
  await page.context().close();
});

test('mobile (390px): client list becomes cards and the sidebar drawer opens', async () => {
  const page = await openAdmin({ width: 390, height: 844 }, '#clients');
  await page.waitForSelector('#clients-table-body tr[data-client-id]');
  const rowDisplay = await page.$eval('#clients-table-body tr[data-client-id]', (el) => getComputedStyle(el).display);
  assert.equal(rowDisplay, 'block', 'rows stack into cards on mobile');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal page overflow at 390px (was ${overflow}px)`);

  await page.click('#mobile-sidebar-toggle-btn');
  await page.waitForFunction(() => document.getElementById('sidebar').classList.contains('mobile-open'));
  await page.context().close();
});
