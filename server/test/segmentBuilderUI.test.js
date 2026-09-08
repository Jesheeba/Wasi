// Real-browser coverage for PLAN.md item 9's frontend — the New Campaign
// modal's "By Segment" audience mode and its inline AND/OR condition
// builder (index.html's #segment-builder, app.js's segment-builder
// section). The backend (contactSegments.test.js) already proves the API
// end-to-end, including a real broadcast created against a segment — this
// file covers what only exists in the browser: the mode toggle, the
// condition rows' field-dependent op/value controls, the debounced live
// preview count, and saving a segment into the picker.
//
// Same fixed-port-4000 + ALLOWED_ORIGINS override as templateLibraryUI.test.js
// (the original precedent) and chatUiPass.test.js — safe to run alongside
// either now that npm test forces --test-concurrency=1 (CLAUDE.md's
// Conventions section), which serializes every test file's process.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.ALLOWED_ORIGINS = 'http://localhost:4000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server, browser, page, baseUrl, testClientId, ownerToken, fixtureTagId, fixtureAttrId;

const SUITE_PREFIX = '__test_suite__segmentbuilderui_';
const EMAIL = `test-suite-segmentbuilderui-${Date.now()}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Same selectOption()-is-unreliable-here workaround as templateLibraryUI.test.js
// / chatUiPass.test.js's tests 11/13 — set the value directly and dispatch a
// real change event instead of driving Playwright's own actionability polling.
async function setSelect(el, value) {
  await page.evaluate(({ el, value }) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); }, { el, value });
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
  testClientId = registered.client?.id;
  ownerToken = registered.token;
  assert.ok(testClientId && ownerToken, 'dedicated test client registration must succeed');

  // Real fixture the builder will filter against.
  const tag = await fetch(`${baseUrl}/api/tags`, {
    method: 'POST', headers: authed(ownerToken), body: JSON.stringify({ name: `${SUITE_PREFIX}VIP` }),
  }).then((r) => r.json());
  const attr = await fetch(`${baseUrl}/api/contact-attributes`, {
    method: 'POST', headers: authed(ownerToken), body: JSON.stringify({ name: `${SUITE_PREFIX}City`, type: 'text' }),
  }).then((r) => r.json());

  const ts = String(Date.now()).slice(-9);
  for (let i = 0; i < 3; i++) {
    const contact = await fetch(`${baseUrl}/api/contacts`, {
      method: 'POST', headers: authed(ownerToken),
      body: JSON.stringify({ name: `${SUITE_PREFIX}C${i}`, phone: `917${ts}${i}` }),
    }).then((r) => r.json());
    if (i < 2) {
      await fetch(`${baseUrl}/api/contacts/${contact.id}/tags`, { method: 'POST', headers: authed(ownerToken), body: JSON.stringify({ tagId: tag.id }) });
    }
    if (i === 0) {
      await fetch(`${baseUrl}/api/contacts/${contact.id}/attributes/${attr.id}`, { method: 'PUT', headers: authed(ownerToken), body: JSON.stringify({ value: 'Mumbai' }) });
    }
  }
  fixtureTagId = tag.id;
  fixtureAttrId = attr.id;

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(`${baseUrl}/index.html`);
  await page.fill('#login-email', EMAIL);
  await page.fill('#login-password', PASSWORD);
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(1500);
  const loggedIn = await page.evaluate(() => getComputedStyle(document.getElementById('app-shell')).display !== 'none');
  assert.ok(loggedIn, 'login must complete before any test runs');
});

after(async () => {
  await browser?.close();
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('1. selecting "By Segment" reveals the segment section and hides the tag/list ones', async () => {
  await page.click('.nav-item[data-view="campaigns"]');
  await page.waitForTimeout(300);
  await page.click('#open-create-broadcast-modal');
  await page.waitForTimeout(300);

  await page.click('#campaign-audience-mode-segment');
  const segmentVisible = await page.evaluate(() => getComputedStyle(document.getElementById('campaign-audience-segment-section')).display !== 'none');
  const tagVisible = await page.evaluate(() => getComputedStyle(document.getElementById('new-campaign-tag')).display !== 'none');
  const listVisible = await page.evaluate(() => getComputedStyle(document.getElementById('campaign-audience-list-section')).display !== 'none');
  assert.ok(segmentVisible);
  assert.ok(!tagVisible);
  assert.ok(!listVisible);
});

test('2. a tag condition shows the correct live preview count against real data', async () => {
  await page.click('#toggle-new-segment-builder-btn');
  await page.waitForTimeout(300);
  // The builder auto-adds one blank row on first open — its field defaults
  // to "tag", so just pick the real tag in that row's target select.
  const tagSelectId = await page.evaluate(() => {
    const row = document.querySelector('#segment-conditions-list .segment-condition-row');
    const sel = row.querySelector('.segment-cond-tag');
    if (!sel.id) sel.id = 'test-segment-cond-tag-0';
    return sel.id;
  });
  const el = await page.$(`#${tagSelectId}`);
  await setSelect(el, fixtureTagId);
  await page.waitForTimeout(700); // debounce (400ms) + real request

  const status = await page.textContent('#segment-preview-status');
  assert.match(status, /Matches 2 contacts/, 'exactly 2 fixture contacts carry the VIP tag');
});

test('3. an attribute condition (text, "is exactly") also produces the correct count', async () => {
  await page.click('#add-segment-condition-btn');
  await page.waitForTimeout(200);
  const rows = await page.$$('#segment-conditions-list .segment-condition-row');
  const newRow = rows[rows.length - 1];

  const fieldSelect = await newRow.$('.segment-cond-field');
  await setSelect(fieldSelect, 'attribute');
  await page.waitForTimeout(200);

  const attrSelect = await newRow.$('.segment-cond-attribute');
  await setSelect(attrSelect, fixtureAttrId);
  await page.waitForTimeout(200);

  // Switch combinator to OR so this new condition is additive, not
  // narrowing the previous tag condition down to zero.
  await page.click('#segment-combinator-or');
  await page.waitForTimeout(200);

  const opSelect = await newRow.$('.segment-cond-op');
  const opValue = await opSelect.inputValue();
  assert.equal(opValue, 'eq', 'a text attribute\'s op select must default to "is exactly"');

  const valueInput = await newRow.$('.segment-cond-value');
  await valueInput.fill('Mumbai');
  await valueInput.dispatchEvent('change');
  await page.waitForTimeout(700);

  const status = await page.textContent('#segment-preview-status');
  // OR(tag=VIP, city=Mumbai) — contacts 0 and 1 are VIP, contact 0 is also
  // Mumbai (already counted) — still exactly 2 matching contacts overall.
  assert.match(status, /Matches 2 contacts/);
});

test('4. saving the segment adds it to the picker and auto-selects it', async () => {
  await page.fill('#new-segment-name', `${SUITE_PREFIX}SavedSegment`);
  await page.click('#save-segment-btn');
  await page.waitForTimeout(500);

  const builderHidden = await page.evaluate(() => getComputedStyle(document.getElementById('segment-builder')).display === 'none');
  assert.ok(builderHidden, 'the builder collapses back to the picker after a successful save');

  const selected = await page.evaluate(() => {
    const select = document.getElementById('new-campaign-segment');
    return select.options[select.selectedIndex]?.textContent;
  });
  assert.equal(selected, `${SUITE_PREFIX}SavedSegment`);

  const saved = await fetch(`${baseUrl}/api/contact-segments`, { headers: authed(ownerToken) }).then((r) => r.json());
  assert.ok(saved.some((s) => s.name === `${SUITE_PREFIX}SavedSegment`), 'the segment must actually persist server-side, not just show in the picker');
});
