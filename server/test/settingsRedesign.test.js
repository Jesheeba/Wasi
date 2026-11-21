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
  for (const s of ['tags', 'canned-responses', 'attributes']) {
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
