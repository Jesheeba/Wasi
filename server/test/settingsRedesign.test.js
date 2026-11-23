// Settings / pop-up / admin redesign (build-docs/features/settings-forms-admin-redesign.md).
// Browser-level checks that the new layouts still drive the SAME API calls:
// inline tag add, drawer forms (+ the unsaved-changes guard), the attribute
// type fix (the old <select> sent "Text", which the server's lowercase enum
// rejected with a 400 on every save), and no horizontal overflow at 375px.
//
// Uses :4000 like every UI suite (app.js API_BASE assumes it); run serially.
// Writes only to a disposable __test_suite__ client, deleted in after().
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const PORT = 4000; // app.js API_BASE targets :4000 unless served from it, same as every UI suite
process.env.ALLOWED_ORIGINS = `http://localhost:${PORT}`;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

const BASE = `http://localhost:${PORT}`;
const SUITE_PREFIX = '__test_suite__settingsredesign_';
const EMAIL = `test-suite-settingsredesign-${Date.now()}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';
let server, browser, token;

before(async () => {
  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${SUITE_PREFIX}client`, email: EMAIL, password: PASSWORD }),
  });
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json());
  token = login.token;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await pool.query('delete from clients where email = $1', [EMAIL]).catch(() => {});
  await pool.end();
});

async function openSettings(width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${BASE}/app`);
  await page.evaluate((t) => { localStorage.setItem('client_token', t); localStorage.setItem('actor_type', 'owner'); }, token);
  await page.goto(`${BASE}/app#settings`);
  await page.reload();
  await page.waitForSelector('#view-settings.active, #view-settings[style*="block"]', { state: 'attached' }).catch(() => {});
  await page.waitForTimeout(1500);
  return page;
}
const goSection = (page, name) => page.evaluate((n) => document.querySelector(`.sec-nav-item[data-sec-view="${n}"]`).click(), name);
const isOpen = (page, id) => page.evaluate((i) => document.getElementById(i).classList.contains('open'), id);

test('tags: added inline (no modal), list shows the new tag, input clears', async () => {
  const page = await openSettings();
  await goSection(page, 'tags');
  await page.fill('#tags-inline-name', `${SUITE_PREFIX}vip`);
  await page.click('label[for="tags-inline-color-1"]');
  await page.click('#tags-inline-add-form button[type="submit"]');
  await page.waitForFunction((n) => document.getElementById('tags-manager-list').textContent.includes(n), `${SUITE_PREFIX}vip`);
  assert.equal(await page.inputValue('#tags-inline-name'), '');
  assert.equal(await isOpen(page, 'modal-add-tag'), false, 'the legacy modal is not used');
  const tags = await fetch(`${BASE}/api/tags`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  const created = tags.find((t) => t.name === `${SUITE_PREFIX}vip`);
  assert.equal(created.color, '#1D4ED8', 'the chosen swatch is what gets saved');
  // Header button jumps to the inline input instead of opening a modal.
  await page.click('#open-add-tag-modal');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tags-inline-name');
  await page.close();
});

test('canned response: drawer, live preview, discard guard, save', async () => {
  const page = await openSettings();
  await goSection(page, 'canned-responses');
  await page.click('#open-add-canned-response-modal');
  assert.ok(await page.evaluate(() => document.getElementById('modal-add-canned-response').classList.contains('as-drawer')));
  await page.fill('#new-canned-shortcut', `${SUITE_PREFIX}hours`);
  await page.fill('#new-canned-body', 'We are open 9 to 7.');
  assert.equal(await page.textContent('#new-canned-preview'), 'We are open 9 to 7.');
  assert.match(await page.textContent('#new-canned-body-count'), /19 characters/);

  // Escape with typed input asks first; cancelling keeps the drawer and the text.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('modal-confirm').classList.contains('open'));
  assert.equal(await isOpen(page, 'modal-add-canned-response'), true);
  await page.evaluate(() => document.querySelector('#modal-confirm [data-close-modal], #modal-confirm .btn-secondary').click());
  await page.waitForFunction(() => !document.getElementById('modal-confirm').classList.contains('open'));
  assert.equal(await page.inputValue('#new-canned-body'), 'We are open 9 to 7.');

  await page.click('#add-canned-response-form button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById('modal-add-canned-response').classList.contains('open'));
  await page.waitForFunction((n) => document.getElementById('canned-responses-table-body').textContent.includes(n), `${SUITE_PREFIX}hours`);
  assert.equal(await page.textContent('#new-canned-preview'), 'Your message will appear here.', 'preview resets with the form');
  await page.close();
});

test('canned response: discarding a dirty drawer clears it', async () => {
  const page = await openSettings();
  await goSection(page, 'canned-responses');
  await page.click('#open-add-canned-response-modal');
  await page.fill('#new-canned-body', 'draft text');
  await page.click('#modal-add-canned-response .close-modal-btn');
  await page.waitForFunction(() => document.getElementById('modal-confirm').classList.contains('open'));
  await page.click('#modal-confirm-action-btn');
  await page.waitForFunction(() => !document.getElementById('modal-add-canned-response').classList.contains('open'));
  assert.equal(await page.inputValue('#new-canned-body'), '');
  // A clean drawer closes straight away, no prompt.
  await page.click('#open-add-canned-response-modal');
  await page.click('#modal-add-canned-response .close-modal-btn');
  await page.waitForTimeout(300);
  assert.equal(await isOpen(page, 'modal-confirm'), false);
  assert.equal(await isOpen(page, 'modal-add-canned-response'), false);
  await page.close();
});

test('attribute: drawer saves with a lowercase type (was a 400 on every save)', async () => {
  const page = await openSettings();
  await goSection(page, 'attributes');
  await page.click('#open-add-attribute-modal');
  await page.fill('#new-attribute-name', `${SUITE_PREFIX}budget`);
  await page.click('label.option-card:has(input[value="number"])');
  await page.click('#add-attribute-form button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById('modal-add-attribute').classList.contains('open'));
  await page.waitForFunction((n) => document.getElementById('attributes-table-body').textContent.includes(n), `${SUITE_PREFIX}budget`);
  assert.match(await page.textContent('#attributes-table-body'), /Number field/);
  const attrs = await fetch(`${BASE}/api/contact-attributes`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  assert.equal(attrs.find((a) => a.name === `${SUITE_PREFIX}budget`).type, 'number');
  await page.close();
});

test('375px: redesigned sections and drawers have no horizontal overflow', async () => {
  const page = await openSettings(375);
  for (const s of ['tags', 'canned-responses', 'attributes', 'subscription', 'billing', 'team', 'webhook', 'whatsapp']) {
    await goSection(page, s);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${s} overflows`);
  }
  await page.evaluate(() => document.getElementById('modal-add-attribute').classList.add('open'));
  await page.waitForTimeout(300);
  const box = await page.evaluate(() => document.querySelector('#modal-add-attribute .modal-box').getBoundingClientRect().width);
  assert.ok(box <= 375 && box >= 370, `drawer is full width on a phone (got ${box})`);
  await page.close();
});

test('subscription: every plan is shown side by side; Choose opens checkout with it pre-selected', async () => {
  const plans = await fetch(`${BASE}/api/billing/plans`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  const page = await openSettings();
  await goSection(page, 'subscription');
  await page.waitForFunction(() => document.querySelectorAll('#subscription-content .plan-card').length > 0);
  assert.equal(await page.locator('#subscription-content .plan-card').count(), plans.length);
  const target = plans[plans.length - 1].id;
  await page.click(`[data-choose-plan="${target}"]`);
  assert.equal(await isOpen(page, 'modal-choose-plan'), true);
  assert.equal(await page.evaluate((id) => document.querySelector(`#choose-plan-options .plan-option[data-plan-id="${id}"]`).classList.contains('selected'), target), true);
  assert.equal(await page.isDisabled('#choose-plan-confirm-btn'), false);
  await page.close();
});

test('billing: summary tiles render above the invoice table', async () => {
  const page = await openSettings();
  await goSection(page, 'billing');
  await page.waitForFunction(() => document.querySelectorAll('#billing-stats .stat-tile').length === 3);
  assert.match(await page.textContent('#billing-stats'), /Invoices\s*0/);
  assert.match(await page.textContent('#billing-invoices-body'), /No invoices yet/);
  await page.close();
});

test('team: invite drawer sends the role picked from the role cards; member row + tiles appear', async () => {
  const page = await openSettings();
  await goSection(page, 'team');
  await page.waitForFunction(() => document.querySelectorAll('#team-stats .stat-tile').length === 3);
  await page.click('#open-invite-member-modal');
  assert.ok(await page.evaluate(() => document.getElementById('modal-invite-member').classList.contains('as-drawer')));
  await page.fill('#new-member-name', 'Suite Agent');
  await page.fill('#new-member-email', `agent-${Date.now()}@wasi.local`);
  await page.click('label.option-card:has(input[value="Agent"])');
  const req = page.waitForRequest((r) => r.url().endsWith('/api/team-members') && r.method() === 'POST');
  await page.click('#invite-member-form button[type="submit"]');
  assert.equal(JSON.parse((await req).postData()).role, 'Agent');
  await page.waitForFunction(() => document.getElementById('team-table-body').textContent.includes('Suite Agent'));
  assert.match(await page.textContent('#team-table-body'), /Agent[\s\S]*Invited/);
  assert.match(await page.textContent('#team-stats'), /Invites pending\s*1/);
  await page.close();
});

test('webhook: form when unset; after save the new secret stays visible; reload shows summary; Edit/Cancel toggle', async () => {
  const page = await openSettings();
  await goSection(page, 'webhook');
  await page.waitForTimeout(800);
  assert.equal(await page.isVisible('#webhook-form-card'), true);
  assert.equal(await page.isVisible('#webhook-status-card'), false);
  await page.fill('#webhook-url-input', 'https://example.com/suite-hook');
  await page.click('#save-webhook-btn');
  await page.waitForFunction(() => /copy it now/.test(document.getElementById('webhook-secret-hint').textContent));
  assert.equal(await page.isVisible('#webhook-form-card'), true, 'stays on the form so the one-time secret can be copied');
  await page.close();

  const again = await openSettings();
  await goSection(again, 'webhook');
  await again.waitForFunction(() => !document.getElementById('webhook-status-card').hidden);
  assert.equal(await again.isVisible('#webhook-form-card'), false);
  assert.match(await again.textContent('#webhook-status-card'), /Sending 4 events[\s\S]*suite-hook/);
  await again.click('#edit-webhook-btn');
  assert.equal(await again.isVisible('#webhook-form-card'), true);
  await again.fill('#webhook-url-input', 'https://example.com/changed-but-cancelled');
  await again.click('#cancel-webhook-edit-btn');
  assert.equal(await again.isVisible('#webhook-status-card'), true);
  assert.equal(await again.inputValue('#webhook-url-input'), 'https://example.com/suite-hook', 'cancel restores the saved URL');
  await again.close();
});

test('whatsapp (not connected): one connect guide instead of three empty tabs', async () => {
  const page = await openSettings();
  await goSection(page, 'whatsapp');
  await page.waitForFunction(() => document.querySelectorAll('#whatsapp-profile-content .connect-steps li').length === 3);
  assert.equal(await page.isVisible('#sec-view-whatsapp .inner-tabs-list'), false);
  assert.equal(await page.isVisible('#settings-connect-wa-btn'), true);
  // Inner tabs are scoped per section: switching WhatsApp's tab must not
  // blank Developer's active panel (it used to, page-wide).
  await goSection(page, 'developer');
  await page.waitForTimeout(400);
  assert.equal(await page.isVisible('#new-api-key-btn'), true);
  await page.click('#sec-view-developer .inner-tab-btn[data-inner-tab="dev-docs"]');
  await goSection(page, 'whatsapp');
  await page.waitForTimeout(400);
  assert.equal(await page.isVisible('#whatsapp-profile-content .connect-steps'), true);
  await page.close();
});

test('remaining pop-ups open as drawers and still submit the same requests', async () => {
  const page = await openSettings();
  const drawers = ['modal-add-contact', 'modal-create-ticket', 'modal-create-payment', 'modal-create-rule', 'modal-invite-member', 'modal-add-attribute', 'modal-add-canned-response'];
  for (const id of drawers) {
    assert.ok(await page.evaluate((i) => document.getElementById(i).classList.contains('as-drawer'), id), `${id} is a drawer`);
  }

  // Add Contact through the drawer.
  await page.evaluate(() => { location.hash = 'contacts'; });
  await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('modal-add-contact').classList.add('open'));
  await page.fill('#new-contact-name', `${SUITE_PREFIX}contact`);
  await page.fill('#new-contact-phone', `91900${String(Date.now()).slice(-7)}`);
  const contactReq = page.waitForResponse((r) => r.url().endsWith('/api/contacts') && r.request().method() === 'POST');
  await page.click('#add-contact-form button[type="submit"]');
  assert.equal((await contactReq).status(), 201);

  // Payment link: same body as before; the fake gateway <select> is gone.
  assert.equal(await page.$('#new-payment-gateway'), null);
  await page.evaluate(() => document.getElementById('modal-create-payment').classList.add('open'));
  await page.fill('#new-payment-customer', 'Suite Customer');
  await page.fill('#new-payment-amount', '1500');
  const payReq = page.waitForRequest((r) => r.url().endsWith('/api/payment-links') && r.method() === 'POST');
  await page.click('#create-payment-form button[type="submit"]');
  assert.deepEqual(JSON.parse((await payReq).postData()), { title: 'Payment from Suite Customer', amount_inr: 1500 });
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelectorAll('.modal-overlay.open').forEach((o) => o.classList.remove('open')));

  // Create Rule keeps its form and saves from the drawer.
  await page.evaluate(() => { location.hash = 'automation'; });
  await page.waitForTimeout(800);
  await page.click('#open-create-rule-modal');
  await page.fill('#new-rule-title', `${SUITE_PREFIX}rule`);
  await page.fill('#new-rule-trigger', 'hours');
  await page.fill('#new-rule-action', 'We are open 9 to 7.');
  await page.click('#create-rule-form button[type="submit"]');
  await page.waitForFunction((n) => document.getElementById('automation-rules-grid').textContent.includes(n), `${SUITE_PREFIX}rule`);
  await page.close();
});
