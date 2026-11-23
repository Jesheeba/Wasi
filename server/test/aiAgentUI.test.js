// AI assistant UI (build-docs/features/ai-agent.md): Settings > AI Assistant
// and the inbox markers. Playwright against createApp() on its OWN port,
// opened as http://[::1]:PORT so app.js's API_BASE resolves to the page's own
// origin (it only redirects to :4000 for 'localhost'/'127.0.0.1'). Any request
// to :4000 is aborted, so this can never reach another dev server there. Disposable __test_suite__ clients,
// deleted in after(). The model and key check are stubbed in-process: nothing
// reaches Anthropic, and nothing is ever sent on WhatsApp.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const PORT = 4107;
process.env.ALLOWED_ORIGINS = `http://[::1]:${PORT}`;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const model = require('../src/services/aiAgent/model');

const BASE = `http://[::1]:${PORT}`;
const SUITE = '__test_suite__aiagentui_';
const stamp = Date.now();
const EMAIL = `test-suite-aiagentui-${stamp}@wasi.local`;
const OTHER = `test-suite-aiagentui-other-${stamp}@wasi.local`;
const PASSWORD = 'test-suite-password-12345';
let server, browser, token, clientId, otherToken, otherId;
const originals = { callModel: model.callModel, countTokens: model.countTokens };

async function register(email) {
  await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ businessName: `${SUITE}${email.slice(0, 5)}`, email, password: PASSWORD }) });
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) }).then((r) => r.json());
  return { token: login.token, id: (await pool.query('select id from clients where email = $1', [email])).rows[0].id };
}

before(async () => {
  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  ({ token, id: clientId } = await register(EMAIL));
  ({ token: otherToken, id: otherId } = await register(OTHER));
  process.env.AI_LIVE_ALLOWLIST = `${clientId}:9092766740`;
  process.env.AI_PLATFORM_KEY_CLIENT_IDS = '';
  model.countTokens = async ({ text }) => Math.ceil(String(text).length / 4);
  model.callModel = async () => ({ text: 'The course fee is Rs 12,000.', tokensIn: 800, tokensCached: 0, tokensOut: 20, costPaise: 8, latencyMs: 900 });
  browser = await chromium.launch();
});

after(async () => {
  model.callModel = originals.callModel; model.countTokens = originals.countTokens;
  await browser?.close();
  await new Promise((r) => server.close(r));
  await pool.query('delete from clients where id = any($1::uuid[])', [[clientId, otherId]]).catch(() => {});
  await pool.end();
});

async function openApp(t, hash, width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.route((url) => url.port === '4000', (route) => { console.error('BLOCKED request to :4000', route.request().url()); return route.abort(); });
  await page.goto(`${BASE}/app`);
  await page.evaluate((tok) => { localStorage.setItem('client_token', tok); localStorage.setItem('actor_type', 'owner'); }, t);
  await page.goto(`${BASE}/app#${hash}`);
  await page.reload();
  await page.waitForTimeout(1200);
  return page;
}
async function openAiSettings(width) {
  const page = await openApp(token, 'settings', width);
  await page.evaluate(() => document.querySelector('.sec-nav-item[data-sec-view="ai-assistant"]').click());
  await page.waitForFunction(() => document.getElementById('ai-consent-text').textContent.length > 20);
  return page;
}
const agentRow = async () => (await pool.query('select * from ai_agents where client_id = $1', [clientId])).rows[0];

test('AC: settings - consent, key, profile + staff hours, knowledge with meter, try-it, switch on', async () => {
  const page = await openAiSettings();
  assert.match(await page.textContent('#ai-checklist'), /Data-processing statement agreed/);
  assert.equal(await page.isHidden('#ai-pilot-note'), true, 'pilot client sees no pilot banner');

  await page.check('#ai-consent-checkbox');
  await page.waitForFunction(() => /Agreed on/.test(document.getElementById('ai-consent-meta').textContent));
  assert.ok((await agentRow()).ai_consent_at);

  await page.fill('#ai-key-input', 'sk-ant-ui-test-key-abcd');
  await page.click('#ai-key-form button[type=submit]');
  await page.waitForFunction(() => /…abcd/.test(document.getElementById('ai-key-current').textContent));
  assert.equal(await page.inputValue('#ai-key-input'), '', 'key field cleared, never shown again');

  await page.fill('#ai-business-name', 'Acme Coaching');
  await page.fill('#ai-description', 'TNPSC coaching in Chennai.');
  await page.evaluate(() => document.querySelectorAll('#ai-staff-days .chip-btn').forEach((b) => { if (b.dataset.aiDay === '0') b.click(); }));
  // Wait for the save itself: the checklist can already look "done" before it.
  const putDone = page.waitForResponse((r) => r.url().endsWith('/api/ai-agent') && r.request().method() === 'PUT');
  await page.click('#ai-settings-form button[type=submit]');
  assert.equal((await putDone).status(), 200);
  const saved = await agentRow();
  assert.equal(saved.business_name, 'Acme Coaching');
  assert.deepEqual(saved.staff_hours[0].days, [0, 1, 2, 3, 4, 5, 6], 'Sunday added to the default Mon-Sat');

  await page.fill('#ai-qa-question', 'What are the fees?');
  await page.fill('#ai-qa-answer', 'The course fee is Rs 12,000.');
  await page.click('#ai-qa-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#ai-sources .list-row').length === 1);
  assert.match(await page.textContent('#ai-meter-label'), /of 2,500 tokens used/);
  assert.notEqual(await page.textContent('#ai-meter-label'), '0 of 2,500 tokens used');

  await page.fill('#ai-try-input', 'fees?');
  await page.click('#ai-try-form button[type=submit]');
  await page.waitForSelector('#ai-try-result .wa-bubble.out');
  assert.equal(await page.textContent('#ai-try-result .wa-bubble.out'), 'The course fee is Rs 12,000.');

  await page.check('#ai-enabled-toggle');
  await page.waitForFunction(() => /^On/.test(document.getElementById('ai-enabled-label').textContent));
  assert.equal((await agentRow()).is_enabled, true);
  assert.equal(await page.inputValue('#ai-mode'), 'shadow', 'starts in practice mode');
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'ai-settings-1440.png') });
  for (const id of ['ai-profile-title', 'ai-knowledge-title', 'ai-try-title', 'ai-activity-title']) {
    await page.locator(`section[aria-labelledby="${id}"]`).screenshot({ path: require('path').join(require('os').tmpdir(), `${id}.png`) });
  }
  await page.close();
});

test('AC: a client outside the pilot sees the pilot note and cannot switch on (error shown, toggle reverts)', async () => {
  const page = await openApp(otherToken, 'settings');
  await page.evaluate(() => document.querySelector('.sec-nav-item[data-sec-view="ai-assistant"]').click());
  await page.waitForFunction(() => !document.getElementById('ai-pilot-note').hidden);
  await page.check('#ai-enabled-toggle');
  await page.waitForFunction(() => !document.getElementById('ai-enabled-toggle').checked);
  assert.equal((await pool.query('select is_enabled from ai_agents where client_id = $1', [otherId])).rows[0].is_enabled, false);
  await page.close();
});

test('AC: inbox - needs-a-person pill, queue and note; AI badge; pause toggles only the client mute', async () => {
  const contact = (await pool.query("insert into contacts (client_id, name, phone) values ($1, 'AI Test Customer', '919092766740') returning id", [clientId])).rows[0];
  const chat = (await pool.query(
    "insert into chats (client_id, name, contact_id, last_message_at, ai_handover_reason, ai_handover_at, ai_cooldown_until) values ($1, 'AI Test Customer', $2, now(), 'Question outside what the assistant was told', now(), now() + interval '2 hours') returning id",
    [clientId, contact.id])).rows[0];
  await pool.query("insert into messages (client_id, chat_id, direction, body, sent_at) values ($1, $2, 'in', 'capital of Peru?', now() - interval '1 minute')", [clientId, chat.id]);
  const out = (await pool.query("insert into messages (client_id, chat_id, direction, body, status, sent_at) values ($1, $2, 'out', 'I have passed this on to our team.', 'sent', now()) returning id", [clientId, chat.id])).rows[0];
  const agent = await agentRow();
  await pool.query("insert into ai_replies (client_id, agent_id, conversation_id, outbound_message_id, mode, customer_text, outcome, model) values ($1, $2, $3, $4, 'live', 'capital of Peru?', 'refused_out_of_scope', 'claude-haiku-4-5')", [clientId, agent.id, chat.id, out.id]);

  const page = await openApp(token, 'chat');
  await page.waitForSelector(`[data-chat-id="${chat.id}"] .is-needs-person`);
  await page.click('[data-queue-filter="needs-person"]');
  assert.equal(await page.locator('#inbox-chat-list [data-chat-id]').count(), 1, 'queue shows only the flagged chat');
  await page.click(`[data-chat-id="${chat.id}"]`);
  await page.waitForFunction(() => !document.getElementById('chat-ai-note').hidden);
  assert.match(await page.textContent('#chat-ai-note'), /Needs a person: Question outside/);
  await page.waitForSelector('.msg-ai-label');
  assert.match(await page.textContent('.msg-ai-label'), /Assistant/);

  // Wait for the real request (waitForFunction treats a Promise as truthy).
  const muteDone = page.waitForResponse((r) => r.url().endsWith(`/api/chats/${chat.id}/ai-mute`));
  await page.evaluate(() => document.getElementById('chat-ai-mute-btn').click());
  assert.equal((await muteDone).status(), 200);
  const row = (await pool.query('select ai_muted, ai_cooldown_until from chats where id = $1', [chat.id])).rows[0];
  assert.equal(row.ai_muted, true); assert.ok(row.ai_cooldown_until, 'pausing never touches the cooldown');
  await page.close();
});

test('AC7: a client without the assistant sees no AI controls in the inbox', async () => {
  const contact = (await pool.query("insert into contacts (client_id, name, phone) values ($1, 'Plain Customer', '919000000001') returning id", [otherId])).rows[0];
  const chat = (await pool.query("insert into chats (client_id, name, contact_id, last_message_at) values ($1, 'Plain Customer', $2, now()) returning id", [otherId, contact.id])).rows[0];
  await pool.query("insert into messages (client_id, chat_id, direction, body, sent_at) values ($1, $2, 'in', 'hello', now())", [otherId, chat.id]);
  const page = await openApp(otherToken, 'chat');
  await page.click(`[data-chat-id="${chat.id}"]`);
  await page.waitForTimeout(1200);
  assert.equal(await page.isHidden('#chat-ai-note'), true);
  assert.equal(await page.isHidden('#chat-ai-mute-btn'), true);
  await page.close();
});

test('375px: AI settings has no horizontal overflow', async () => {
  const page = await openAiSettings(375);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'ai-settings-375.png'), fullPage: true });
  await page.close();
});
