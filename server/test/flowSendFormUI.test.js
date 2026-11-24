// Bot Flow "Send form" step in the CRM's List-view flow editor
// (build-docs/features/whatsapp-flows.md). Real browser, local test DB,
// disposable __test_suite__ client; nothing is sent to Meta.
// Uses :4000 like every UI suite (app.js API_BASE assumes it); run serially.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const PORT = Number(process.env.UI_TEST_PORT || 4000);
const HOST = process.env.UI_TEST_HOST || 'localhost';
process.env.ALLOWED_ORIGINS = `http://${HOST}:${PORT}`;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

const BASE = `http://${HOST}:${PORT}`;
const EMAIL = `test-suite-sendform-${Date.now()}@wasi.local`;
let server, browser, token, clientId, flowId, formId;

const api = (path, opts = {}) => fetch(`${BASE}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }).then((r) => r.json());

before(async () => {
  server = createApp().listen(PORT, HOST);
  await new Promise((r) => server.once('listening', r));
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: '__test_suite__sendform', email: EMAIL, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  token = reg.token;
  clientId = reg.client.id;
  const ins = (name, status, meta) => pool.query(
    `insert into whatsapp_flows (client_id, name, kind, config, status, meta_flow_id) values ($1, $2, 'onboarding', '{}', $3, $4) returning id`,
    [clientId, name, status, meta]);
  formId = (await ins('Wasi onboarding', 'draft', 'META_OK')).rows[0].id;
  await ins('Retired form', 'deprecated', 'META_OLD');
  await ins('Never accepted', 'draft', null);
  flowId = (await api('/api/automation-flows', { method: 'POST', body: JSON.stringify({ name: 'Onboarding flow' }) })).id;
  await api(`/api/automation-flows/${flowId}/nodes`, { method: 'POST', body: JSON.stringify({ type: 'send_text', config: { body: 'Thanks, we will call you.' } }) });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
  if (clientId) await pool.query('delete from clients where id = $1', [clientId]);
  await pool.end();
});

test('Add Node > Send Form: only sendable forms are offered, the step saves, and its branches read as submitted / not submitted', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/app`);
  await page.evaluate((tk) => { localStorage.setItem('client_token', tk); localStorage.setItem('actor_type', 'owner'); }, token);
  await page.goto(`${BASE}/app#automation`);
  await page.reload();
  await page.waitForSelector('#view-automation.active');
  await page.click('#automation-tab-flows');
  await page.click(`tr.flow-card[data-flow-id="${flowId}"]`);
  await page.waitForSelector('#modal-bot-flow-editor.open');

  await page.click('#bot-flow-editor-add-node-btn');
  await page.waitForSelector('#modal-add-bot-flow-node.open');
  await page.selectOption('#new-bot-flow-node-type', 'send_form');
  await page.waitForSelector('#new-bot-flow-node-form-id');
  const offered = await page.$$eval('#new-bot-flow-node-form-id option', (os) => os.map((o) => o.textContent));
  assert.deepEqual(offered, ['Wasi onboarding (draft)'], 'retired and never-accepted forms are not offered');
  await page.fill('#new-bot-flow-node-cta', 'Start now');
  await page.click('#add-bot-flow-node-form button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById('modal-add-bot-flow-node').classList.contains('open'));

  const graph = await api(`/api/automation-flows/${flowId}`);
  const node = graph.nodes.find((n) => n.type === 'send_form');
  assert.deepEqual(node.config, { form_id: formId, body: 'Please fill in this short form.', cta: 'Start now' });
  await page.waitForFunction(() => /Form: Wasi onboarding/.test(document.getElementById('modal-bot-flow-editor').innerText));

  await page.click(`.add-flow-edge-btn[data-node-id="${node.id}"]`);
  await page.waitForSelector('#modal-add-bot-flow-edge.open');
  const branchTypes = await page.$$eval('#new-bot-flow-edge-condition-type option', (os) => os.map((o) => o.textContent));
  assert.deepEqual(branchTypes, ['The form is submitted', 'Not submitted in time']);
  assert.deepEqual(errors, []);
  await page.close();
});
