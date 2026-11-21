// Admin redesign (build-docs/features/settings-forms-admin-redesign.md, step 6):
// summary tiles that filter Clients and Onboarding, the Invite Admin drawer,
// and the Client Detail summary strip. Read-only against the database: the
// one write (Invite Admin) is intercepted in the browser, never sent.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const PORT = 4000; // admin/app.js API_BASE targets :4000 unless served from it
process.env.ALLOWED_ORIGINS = `http://localhost:${PORT}`;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { ADMIN_EMAIL, ADMIN_PASSWORD } = require('./helpers/adminCredentials');

const BASE = `http://localhost:${PORT}`;
let server, browser, login;

before(async () => {
  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  // One login for the whole file: the admin login route is rate-limited.
  login = await fetch(`${BASE}/api/admin/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }).then((r) => r.json());
  assert.ok(login.token, 'admin login');
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await pool.end();
});

const api = (path) => fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${login.token}` } }).then((r) => r.json());

async function openAdmin(hash) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${BASE}/admin/`);
  await page.evaluate(([t, a]) => { localStorage.setItem('admin_token', t); localStorage.setItem('admin_profile', JSON.stringify(a)); }, [login.token, login.admin]);
  await page.goto(`${BASE}/admin/#${hash}`);
  await page.reload();
  return page;
}

test('clients: summary tiles match the API and filter the table (status + unpaid)', async () => {
  const clients = await api('/api/clients');
  const page = await openAdmin('clients');
  await page.waitForSelector('#clients-summary [data-clients-filter]');
  const value = (k) => page.textContent(`#clients-summary [data-clients-filter="${k}"] .kpi-value`).then(Number);
  assert.equal(await value(''), clients.length);
  assert.equal(await value('active'), clients.filter((c) => c.status === 'active').length);
  assert.equal(await value('unpaid'), clients.filter((c) => c.payment_status === 'unpaid').length);

  await page.click('#clients-summary [data-clients-filter="pending_setup"]');
  assert.equal(await page.inputValue('#clients-status-filter'), 'pending_setup');
  assert.equal(await page.getAttribute('#clients-summary [data-clients-filter="pending_setup"]', 'aria-pressed'), 'true');
  const pending = clients.filter((c) => c.status === 'pending_setup').length;
  assert.match(await page.textContent('#clients-count-label'), new RegExp(`^${pending} client`));

  await page.click('#clients-summary [data-clients-filter="unpaid"]');
  assert.equal(await page.inputValue('#clients-status-filter'), '', 'unpaid is not a status, so the dropdown resets');
  const unpaid = clients.filter((c) => c.payment_status === 'unpaid').length;
  assert.match(await page.textContent('#clients-count-label'), new RegExp(`^${unpaid} client`));

  // Choosing a status in the dropdown clears the unpaid filter.
  await page.selectOption('#clients-status-filter', 'active').catch(() => {});
  await page.evaluate(() => document.getElementById('clients-status-filter').dispatchEvent(new Event('change', { bubbles: true })));
  assert.equal(await page.getAttribute('#clients-summary [data-clients-filter="unpaid"]', 'aria-pressed'), 'false');
  await page.close();
});

test('onboarding: stage tiles count the queue and filter it', async () => {
  const rows = await api('/api/admin/onboarding-queue');
  const page = await openAdmin('onboarding');
  await page.waitForSelector('#onboarding-funnel [data-onboarding-stage]');
  assert.equal(Number(await page.textContent('#onboarding-funnel [data-onboarding-stage=""] .kpi-value')), rows.length);
  // A stage that actually has clients, so the filter is really exercised.
  const stage = rows.find((r) => r.stuck_at)?.stuck_at;
  assert.ok(stage, 'local queue has at least one stuck client');
  await page.click(`#onboarding-funnel [data-onboarding-stage="${stage}"]`);
  const expected = rows.filter((r) => r.stuck_at === stage).length;
  const shown = await page.locator('#onboarding-table-body tr[data-client-id]').count();
  assert.equal(shown, expected);
  assert.ok(expected > 0);
  assert.equal(await page.getAttribute(`#onboarding-funnel [data-onboarding-stage="${stage}"]`, 'aria-pressed'), 'true');
  await page.close();
});

test('team: invite admin is a drawer and sends the role picked on the cards (request intercepted)', async () => {
  const page = await openAdmin('team');
  await page.waitForSelector('#team-table-body tr');
  assert.ok(await page.isVisible('.admin-roles-note'), 'roles-not-enforced note is shown');
  let body = null;
  await page.route('**/api/admin/admin-users', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    body = JSON.parse(route.request().postData());
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'x' }) });
  });
  await page.click('#open-invite-admin-btn');
  assert.ok(await page.evaluate(() => document.getElementById('invite-admin-modal').classList.contains('as-drawer')));
  await page.fill('#invite-admin-name', 'Suite Billing');
  await page.fill('#invite-admin-email', 'suite-billing@wasi.local');
  await page.fill('#invite-admin-password', 'suite-password-1');
  await page.click('label.option-card:has(input[value="billing"])');
  await page.click('#invite-admin-submit-btn');
  await page.waitForFunction(() => !document.getElementById('invite-admin-modal').classList.contains('open'));
  assert.equal(body.role, 'billing');
  await page.close();
});

test('client detail: summary strip shows status, plan, WhatsApp, templates, last login', async () => {
  const clients = await api('/api/clients');
  const page = await openAdmin('clients');
  await page.waitForSelector('tr[data-client-id]');
  await page.click(`tr[data-client-id="${clients[0].id}"]`);
  await page.waitForSelector('.client-summary-strip .kpi-tile');
  assert.equal(await page.locator('.client-summary-strip .kpi-tile').count(), 5);
  assert.match(await page.textContent('.client-summary-strip'), /Status[\s\S]*Plan[\s\S]*WhatsApp[\s\S]*Templates[\s\S]*Last login/);
  await page.close();
});
