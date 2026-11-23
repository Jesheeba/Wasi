// Automation rule view/edit/enable-disable
// (build-docs/features/automation-rule-view-edit.md). Test names carry the
// acceptance-criterion number they cover.
//
// Uses :4000 like every UI suite (app.js API_BASE assumes it); run serially.
// Writes only to disposable __test_suite__ clients, deleted in after().
// No WhatsApp message is ever sent: the engine test stubs messagingService.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const PORT = 4000;
process.env.ALLOWED_ORIGINS = `http://localhost:${PORT}`;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const messagingService = require('../src/services/messagingService');
const automationEngine = require('../src/services/automationEngine');

const BASE = `http://localhost:${PORT}`;
const SUITE_PREFIX = '__test_suite__ruleviewedit_';
const stamp = Date.now();
const EMAIL = `test-suite-ruleviewedit-${stamp}@wasi.local`;
const OTHER_EMAIL = `test-suite-ruleviewedit-other-${stamp}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';
let server, browser, token, otherToken, clientId;

async function registerAndLogin(email, name) {
  await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: name, email, password: PASSWORD }),
  });
  return fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  }).then((r) => r.json());
}

const api = (path, opts = {}, t = token) => fetch(`${BASE}${path}`, {
  ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, ...(opts.headers || {}) },
});
const createRule = (body, t) => api('/api/automation-rules', { method: 'POST', body: JSON.stringify(body) }, t).then((r) => r.json());
const createFlow = (name, t) => api('/api/automation-flows', { method: 'POST', body: JSON.stringify({ name }) }, t).then((r) => r.json());

before(async () => {
  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  const login = await registerAndLogin(EMAIL, `${SUITE_PREFIX}client`);
  token = login.token;
  clientId = (await pool.query('select id from clients where email = $1', [EMAIL])).rows[0].id;
  otherToken = (await registerAndLogin(OTHER_EMAIL, `${SUITE_PREFIX}other`)).token;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await pool.query('delete from clients where email = any($1)', [[EMAIL, OTHER_EMAIL]]).catch(() => {});
  await pool.end();
});

async function openAutomation() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${BASE}/app`);
  await page.evaluate((t) => { localStorage.setItem('client_token', t); localStorage.setItem('actor_type', 'owner'); }, token);
  await page.goto(`${BASE}/app#automation`);
  await page.reload();
  await page.waitForSelector('#automation-rules-grid [data-rule-id]');
  return page;
}

test('AC1+AC2: row opens a prefilled drawer with the full reply as a bubble, and saving edits PATCHes', async () => {
  const longReply = 'Hi! Thanks so much for reaching out. Our office is open Monday to Saturday, 9am to 7pm, and we reply within the hour.';
  const rule = await createRule({ title: `${SUITE_PREFIX}hours`, trigger: 'hours', action: longReply });
  const page = await openAutomation();
  await page.click(`[data-rule-id="${rule.id}"] .automation-trigger`);
  await page.waitForSelector('#modal-create-rule.open');
  assert.equal(await page.inputValue('#new-rule-title'), `${SUITE_PREFIX}hours`);
  assert.equal(await page.textContent('#rule-reply-preview'), longReply);
  assert.equal(await page.textContent('#rule-submit-btn'), 'Save Changes');

  await page.fill('#new-rule-action', 'We are open 9 to 7.');
  assert.equal(await page.textContent('#rule-reply-preview'), 'We are open 9 to 7.', 'preview updates live');
  await page.click('#rule-submit-btn');
  await page.waitForFunction(() => !document.getElementById('modal-create-rule').classList.contains('open'));
  const saved = (await api('/api/automation-rules').then((r) => r.json())).find((r) => r.id === rule.id);
  assert.equal(saved.action, 'We are open 9 to 7.');
  assert.equal(saved.status, 'Enabled');
  const rows = await page.evaluate(() => document.querySelectorAll('#automation-rules-grid [data-rule-id]').length);
  assert.equal(rows, 1, 'edit did not create a second rule');
  await page.close();
});

test('AC3: table switch disables and re-enables a rule, persisting across reload', async () => {
  const rule = await createRule({ title: `${SUITE_PREFIX}toggle`, trigger: 'toggleme', action: 'hello' });
  let page = await openAutomation();
  const sel = `[data-rule-toggle="${rule.id}"]`;
  assert.equal(await page.isChecked(sel), true);
  await page.click(`[data-rule-id="${rule.id}"] .wasi-toggle`);
  await page.waitForFunction((s) => !document.querySelector(s).checked && !document.querySelector(s).disabled, sel);
  assert.equal(await page.evaluate(() => document.getElementById('modal-create-rule').classList.contains('open')), false,
    'clicking the switch must not open the drawer');
  await page.close();

  page = await openAutomation();
  assert.equal(await page.isChecked(sel), false, 'Disabled persisted');
  await page.click(`[data-rule-id="${rule.id}"] .wasi-toggle`);
  await page.waitForFunction((s) => document.querySelector(s).checked && !document.querySelector(s).disabled, sel);
  const saved = (await api('/api/automation-rules').then((r) => r.json())).find((r) => r.id === rule.id);
  assert.equal(saved.status, 'Enabled');
  await page.close();
});

test('AC3: drawer switch saves Disabled, including on create', async () => {
  const page = await openAutomation();
  await page.click('#open-create-rule-modal');
  await page.fill('#new-rule-title', `${SUITE_PREFIX}created-off`);
  await page.fill('#new-rule-trigger', 'createdoff');
  await page.fill('#new-rule-action', 'off from the start');
  await page.click('label[for="rule-status-toggle"]');
  await page.click('#rule-submit-btn');
  await page.waitForFunction(() => !document.getElementById('modal-create-rule').classList.contains('open'));
  const saved = (await api('/api/automation-rules').then((r) => r.json())).find((r) => r.title === `${SUITE_PREFIX}created-off`);
  assert.equal(saved.status, 'Disabled');
  await page.close();
});

test('AC4: a disabled rule is not matched by automationEngine', async () => {
  const rule = await createRule({ title: `${SUITE_PREFIX}engine`, trigger: 'enginecheck', action: 'should not send' });
  await api(`/api/automation-rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'Disabled' }) });
  const original = messagingService.sendChatMessage;
  let sends = 0;
  messagingService.sendChatMessage = async () => { sends += 1; };
  try {
    const outcome = await automationEngine.evaluate(pool, clientId, { id: null }, 'please enginecheck now', null);
    assert.equal(sends, 0);
    assert.equal(outcome?.handled, false);
  } finally {
    messagingService.sendChatMessage = original;
  }
});

test('AC5: switching kind keeps action/flow_id exclusive; both at once is 400', async () => {
  const rule = await createRule({ title: `${SUITE_PREFIX}kind`, trigger: 'kind', action: 'text first' });
  const flow = await createFlow(`${SUITE_PREFIX}flow`);
  let res = await api(`/api/automation-rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ flow_id: flow.id }) });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.flow_id, flow.id);
  assert.equal(body.action, null);

  res = await api(`/api/automation-rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'back to text' }) });
  body = await res.json();
  assert.equal(body.action, 'back to text');
  assert.equal(body.flow_id, null);

  res = await api(`/api/automation-rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'x', flow_id: flow.id }) });
  assert.equal(res.status, 400);
  res = await api(`/api/automation-rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'Active' }) });
  assert.equal(res.status, 400, 'only Enabled/Disabled are accepted');
});

test('AC6: another client\'s flow_id is rejected', async () => {
  const rule = await createRule({ title: `${SUITE_PREFIX}foreign`, trigger: 'foreign', action: 'mine' });
  const foreignFlow = await createFlow(`${SUITE_PREFIX}foreign-flow`, otherToken);
  const res = await api(`/api/automation-rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ flow_id: foreignFlow.id }) });
  assert.equal(res.status, 400);
  const saved = (await api('/api/automation-rules').then((r) => r.json())).find((r) => r.id === rule.id);
  assert.equal(saved.flow_id, null);
});
