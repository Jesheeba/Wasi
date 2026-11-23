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

// ---------------------------------------------------------------- audit fixes
// Letters in test names refer to the audit items in the feature doc.

async function makeChat(name) {
  const contact = (await pool.query(
    'insert into contacts (client_id, name, phone) values ($1, $2, $3) returning id',
    [clientId, name, `9190${Date.now()}${Math.floor(Math.random() * 1000)}`]
  )).rows[0];
  return (await pool.query(
    'insert into chats (client_id, name, contact_id) values ($1, $2, $3) returning id',
    [clientId, name, contact.id]
  )).rows[0];
}

async function withStubbedSend(fn, { fail = false } = {}) {
  const original = messagingService.sendChatMessage;
  const sent = [];
  messagingService.sendChatMessage = async (db, c, chat, msg) => {
    if (fail) throw new Error('stub send failure');
    sent.push(msg.body);
  };
  try { return await fn(sent); } finally { messagingService.sendChatMessage = original; }
}

const disableAll = () => pool.query("update automation_rules set status = 'Disabled' where client_id = $1", [clientId]);

test('H: keywords match whole words and phrases, case-insensitive', () => {
  const m = automationEngine.matchesTrigger;
  assert.equal(m('hi', 'Hi there'), true);
  assert.equal(m('hi', 'this is shipping'), false, 'no match inside another word');
  assert.equal(m('price list', 'send the PRICE   list please'), true, 'phrase, any whitespace');
  assert.equal(m('Hello! Can I get more info on this?', 'Hello! Can I get more info on this?'), true, 'punctuation in trigger');
  assert.equal(m('fees', 'fees?'), true);
  assert.equal(m('கட்டணம்', 'கட்டணம் எவ்வளவு'), true, 'Tamil word');
  assert.equal(m('கட்ட', 'கட்டணம்'), false, 'no match inside a Tamil word');
  assert.equal(m('*', 'anything'), false, '"*" is handled as a wildcard, never as a keyword');
});

test('B: "*" replies to any message, once per chat per 24h, after keyword rules', async () => {
  await disableAll();
  await createRule({ title: `${SUITE_PREFIX}star`, trigger: '*', action: 'catch-all reply' });
  // Created after "*", so it is first in list order: keyword rules must still win regardless.
  await createRule({ title: `${SUITE_PREFIX}kw`, trigger: 'fees', action: 'fees reply' });
  const chat = await makeChat(`${SUITE_PREFIX}chat-b`);
  await withStubbedSend(async (sent) => {
    const kw = await automationEngine.evaluate(pool, clientId, chat, 'what are the fees', null);
    assert.equal(kw.how, 'rule_text_reply');
    const first = await automationEngine.evaluate(pool, clientId, chat, 'hello there', null);
    assert.equal(first.how, 'rule_text_reply');
    const second = await automationEngine.evaluate(pool, clientId, chat, 'another message', null);
    assert.equal(second.handled, false, 'no second catch-all within 24h');
    assert.deepEqual(sent, ['fees reply', 'catch-all reply']);
    await pool.query("update chats set auto_reply_at = now() - interval '25 hours' where id = $1", [chat.id]);
    await automationEngine.evaluate(pool, clientId, chat, 'next day', null);
    assert.deepEqual(sent, ['fees reply', 'catch-all reply', 'catch-all reply'], 'fires again after 24h');
  });
});

test('B: "*" never fires inside an active flow, and a failed send does not use up the 24h', async () => {
  await disableAll();
  await createRule({ title: `${SUITE_PREFIX}star2`, trigger: '*', action: 'catch-all' });
  const chat = await makeChat(`${SUITE_PREFIX}chat-b2`);
  await withStubbedSend(async (sent) => {
    const inFlow = await automationEngine.evaluate(pool, clientId, chat, 'hi', null, { allowWildcard: false });
    assert.equal(inFlow.handled, false);
    assert.equal(sent.length, 0);
  });
  await withStubbedSend(async () => {
    const out = await automationEngine.evaluate(pool, clientId, chat, 'hi', null);
    assert.equal(out.how, 'rule_text_reply_failed');
  }, { fail: true });
  const { rows } = await pool.query('select auto_reply_at from chats where id = $1', [chat.id]);
  assert.equal(rows[0].auto_reply_at, null, 'claim released after the failed send');
  await withStubbedSend(async (sent) => {
    await automationEngine.evaluate(pool, clientId, chat, 'hi again', null);
    assert.deepEqual(sent, ['catch-all'], 'retry succeeds');
  });
});

test('A: deleting a flow that a rule starts succeeds and removes that rule', async () => {
  const flow = await createFlow(`${SUITE_PREFIX}flow-del`);
  const rule = await createRule({ title: `${SUITE_PREFIX}flow-rule`, trigger: 'flowdel', flow_id: flow.id });
  const res = await api(`/api/automation-flows/${flow.id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  const rules = await api('/api/automation-rules').then((r) => r.json());
  assert.equal(rules.some((r) => r.id === rule.id), false);
});

test('I+F: rules can be deleted; ids and blank triggers are validated', async () => {
  const rule = await createRule({ title: `${SUITE_PREFIX}del`, trigger: 'deleteme', action: 'x' });
  assert.equal((await api(`/api/automation-rules/${rule.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/automation-rules/${rule.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await api('/api/automation-rules/not-a-uuid', { method: 'DELETE' })).status, 400);
  assert.equal((await api('/api/automation-rules/not-a-uuid', { method: 'PATCH', body: '{"status":"Enabled"}' })).status, 400);
  const blank = await api('/api/automation-rules', { method: 'POST', body: JSON.stringify({ title: 't', trigger: '   ', action: 'x' }) });
  assert.equal(blank.status, 400);
  const mine = await createRule({ title: `${SUITE_PREFIX}mine`, trigger: 'mine', action: 'x' });
  assert.equal((await api(`/api/automation-rules/${mine.id}`, { method: 'DELETE' }, otherToken)).status, 404, 'cannot delete another client rule');
});

test('D+G+I (UI): draft-flow warning, duplicate-keyword warning, delete from the drawer', async () => {
  await disableAll();
  const draft = await createFlow(`${SUITE_PREFIX}draft-flow`);
  const flowRule = await createRule({ title: `${SUITE_PREFIX}draft-rule`, trigger: 'draftkw', flow_id: draft.id });
  const dup = await createRule({ title: `${SUITE_PREFIX}dup`, trigger: 'samekw', action: 'one' });
  const page = await openAutomation();
  assert.match(await page.textContent(`[data-rule-id="${flowRule.id}"] .automation-flow-warning`), /draft/i);

  await page.click(`[data-rule-id="${flowRule.id}"] .automation-name`);
  await page.waitForSelector('#modal-create-rule.open');
  assert.match(await page.textContent('#new-rule-flow-warning'), /draft/i);
  await page.click('#create-rule-form [data-close-modal="modal-create-rule"]');
  await page.waitForFunction(() => !document.getElementById('modal-create-rule').classList.contains('open'));

  await page.click('#open-create-rule-modal');
  await page.waitForSelector('#modal-create-rule.open');
  assert.equal(await page.isHidden('#rule-delete-btn'), true, 'no delete when creating');
  await page.fill('#new-rule-trigger', 'SameKW');
  assert.match(await page.textContent('#new-rule-trigger-warning'), new RegExp(`${SUITE_PREFIX}dup`));
  await page.evaluate(() => { document.getElementById('create-rule-form').reset(); document.getElementById('modal-create-rule').classList.remove('open'); });

  await page.click(`[data-rule-id="${dup.id}"] .automation-name`);
  await page.waitForSelector('#modal-create-rule.open');
  await page.click('#rule-delete-btn');
  await page.waitForSelector('#modal-confirm.open');
  await page.click('#modal-confirm-action-btn');
  await page.waitForFunction((id) => !document.querySelector(`[data-rule-id="${id}"]`), dup.id);
  const rules = await api('/api/automation-rules').then((r) => r.json());
  assert.equal(rules.some((r) => r.id === dup.id), false);
  await page.close();
});
