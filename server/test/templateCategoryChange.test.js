// Meta's template category changes are recorded and flagged
// (build-docs/features/template-category-change.md). Only graph.facebook.com
// is faked. Runs against TEST_DATABASE_URL (a local database), never the
// shared production one.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const apiKeysRepo = require('../src/repositories/apiKeysRepo');
const messageTemplatesRepo = require('../src/repositories/messageTemplatesRepo');
const templateSyncService = require('../src/services/templateSyncService');
const metaClient = require('../src/utils/metaClient');
const { encrypt } = require('../src/utils/encryption');

const SUITE_PREFIX = '__test_suite__tplcat_';
const WABA_ID = 'test_suite_tplcat_waba';
const PHONE_ID = 'test_suite_tplcat_phone';

let server;
let baseUrl;
let clientId;
let clientToken;
let apiKey;
let metaList = []; // what the fake GET /message_templates returns
let rejectCategoryFields = false;

function installFakeGraph() {
  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, options);
    const ok = (json, status = 200) => ({ ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) });
    if (u.includes(`${WABA_ID}/message_templates`) && (options.method || 'GET') === 'GET') {
      if (rejectCategoryFields && /previous_category/.test(decodeURIComponent(u))) {
        return ok({ error: { message: '(#100) Tried accessing nonexisting field (previous_category)', code: 100 } }, 400);
      }
      return ok({ data: metaList });
    }
    // Meta approves a template submitted as Utility as Marketing.
    if (u.includes(`${WABA_ID}/message_templates`)) return ok({ id: `META_${Date.now()}`, status: 'PENDING', category: 'MARKETING' });
    return ok({});
  };
  return () => { global.fetch = realFetch; };
}

const utilityBody = {
  category: 'Utility',
  language: 'en_US',
  body: 'Your registration for the annual conference is confirmed. Reply here if you need to change your details.',
};

async function insertLocal(name, category, metaId) {
  return messageTemplatesRepo.create(pool, { client_id: clientId, name, category, body: 'Body text for a test template here.', status: 'approved', meta_template_id: metaId });
}

async function postWebhook(value) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field: 'template_category_update', value }] }] });
  const signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('hex');
  const res = await fetch(`${baseUrl}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature }, body });
  assert.equal(res.status, 200);
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${SUITE_PREFIX}client`, email: `test-suite-tplcat-${Date.now()}@wasi.local`, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  clientId = registered.client?.id;
  clientToken = registered.token;
  assert.ok(clientId && clientToken, 'test client registration must succeed');
  await pool.query(`update clients set status = 'active', email_verified = true where id = $1`, [clientId]);
  await wabasRepo.upsertForClient(clientId, {
    waba_id: WABA_ID, phone_number_id: PHONE_ID, status: 'connected',
    access_token_encrypted: encrypt('fake-token-never-sent-to-meta'),
  });
  apiKey = (await apiKeysRepo.create(pool, clientId, `${SUITE_PREFIX}key`)).rawKey;
});

after(async () => {
  if (clientId) {
    await pool.query('delete from audit_log where actor_id = $1 or target like $2', [clientId, `${clientId}%`]);
    await pool.query('delete from clients where id = $1', [clientId]);
  }
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('AC1: CRM create - Meta approving a Utility submission as Marketing is recorded and returned as a warning', async () => {
  const restore = installFakeGraph();
  try {
    const res = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...utilityBody, name: `${SUITE_PREFIX}crm_create` }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.category, 'Marketing');
    assert.equal(body.previous_category, 'Utility');
    assert.ok(body.category_changed_at);
    assert.ok(body.warnings.some((w) => /from Utility to Marketing/.test(w)), JSON.stringify(body.warnings));
  } finally { restore(); }
});

test('AC2: Hub API create - same recording and warning', async () => {
  const restore = installFakeGraph();
  try {
    const res = await fetch(`${baseUrl}/api/v1/templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...utilityBody, name: `${SUITE_PREFIX}hub_create` }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.category, 'Marketing');
    assert.equal(body.previous_category, 'Utility');
    assert.match(body.warnings[0], /opted in/);
  } finally { restore(); }
});

test('AC3: sync - a category that changed on Meta keeps the old one as previous_category', async () => {
  const local = await insertLocal(`${SUITE_PREFIX}sync_changed`, 'Utility', 'META_SYNC_1');
  metaList = [{ id: 'META_SYNC_1', name: local.name, status: 'APPROVED', category: 'MARKETING', language: 'en_US', components: [] }];
  const restore = installFakeGraph();
  try {
    await templateSyncService.syncTemplates(pool, clientId);
    const row = await messageTemplatesRepo.findById(pool, clientId, local.id);
    assert.equal(row.category, 'Marketing');
    assert.equal(row.previous_category, 'Utility');
    assert.ok(row.category_changed_at);
    // A second sync with no change keeps the record, not erasing it.
    await templateSyncService.syncTemplates(pool, clientId);
    const again = await messageTemplatesRepo.findById(pool, clientId, local.id);
    assert.equal(again.previous_category, 'Utility');
    assert.equal(new Date(again.category_changed_at).getTime(), new Date(row.category_changed_at).getTime());
  } finally { restore(); }
});

test('AC4: sync - Meta\'s previous_category backfills a change Wasi already overwrote; correct_category is shown as upcoming', async () => {
  const already = await insertLocal(`${SUITE_PREFIX}sync_backfill`, 'Marketing', 'META_SYNC_2');
  const upcoming = await insertLocal(`${SUITE_PREFIX}sync_upcoming`, 'Utility', 'META_SYNC_3');
  const unchanged = await insertLocal(`${SUITE_PREFIX}sync_same`, 'Utility', 'META_SYNC_4');
  metaList = [
    { id: 'META_SYNC_2', name: already.name, status: 'APPROVED', category: 'MARKETING', previous_category: 'UTILITY', language: 'en_US', components: [] },
    { id: 'META_SYNC_3', name: upcoming.name, status: 'APPROVED', category: 'UTILITY', correct_category: 'MARKETING', language: 'en_US', components: [] },
    { id: 'META_SYNC_4', name: unchanged.name, status: 'APPROVED', category: 'UTILITY', language: 'en_US', components: [] },
  ];
  const restore = installFakeGraph();
  try {
    await templateSyncService.syncTemplates(pool, clientId);
    const a = await messageTemplatesRepo.findById(pool, clientId, already.id);
    assert.equal(a.previous_category, 'Utility');
    const u = await messageTemplatesRepo.findById(pool, clientId, upcoming.id);
    assert.equal(u.category, 'Utility');
    assert.equal(u.upcoming_category, 'Marketing');
    const s = await messageTemplatesRepo.findById(pool, clientId, unchanged.id);
    assert.equal(s.previous_category, null);
    assert.equal(s.upcoming_category, null);
  } finally { restore(); }
});

test('AC5: sync still works when Meta rejects the extra category fields', async () => {
  const local = await insertLocal(`${SUITE_PREFIX}sync_oldgraph`, 'Utility', 'META_SYNC_5');
  metaList = [{ id: 'META_SYNC_5', name: local.name, status: 'APPROVED', category: 'MARKETING', language: 'en_US', components: [] }];
  rejectCategoryFields = true;
  const restore = installFakeGraph();
  try {
    await templateSyncService.syncTemplates(pool, clientId);
    const row = await messageTemplatesRepo.findById(pool, clientId, local.id);
    assert.equal(row.previous_category, 'Utility');
  } finally { restore(); rejectCategoryFields = false; }
});

test('AC6: webhook - advance notice sets upcoming_category, the completed change applies it', async () => {
  const local = await insertLocal(`${SUITE_PREFIX}webhook`, 'Utility', 'META_WH_1');
  const at = Math.floor(Date.now() / 1000) + 86400;
  await postWebhook({ message_template_id: 'META_WH_1', message_template_name: local.name, message_template_language: 'en-US', new_category: 'UTILITY', correct_category: 'MARKETING', category_update_timestamp: at });
  let row = await messageTemplatesRepo.findById(pool, clientId, local.id);
  assert.equal(row.category, 'Utility');
  assert.equal(row.upcoming_category, 'Marketing');
  assert.equal(new Date(row.upcoming_category_at).getTime(), at * 1000);

  await postWebhook({ message_template_id: 'META_WH_1', message_template_name: local.name, message_template_language: 'en-US', previous_category: 'UTILITY', new_category: 'MARKETING' });
  row = await messageTemplatesRepo.findById(pool, clientId, local.id);
  assert.equal(row.category, 'Marketing');
  assert.equal(row.previous_category, 'Utility');
  assert.equal(row.upcoming_category, null);
});

test('AC7: webhook without an id matches by name and "en-US" language', async () => {
  const local = await insertLocal(`${SUITE_PREFIX}webhook_name`, 'Utility', null);
  await postWebhook({ message_template_name: local.name, message_template_language: 'en-US', previous_category: 'UTILITY', new_category: 'MARKETING' });
  const row = await messageTemplatesRepo.findById(pool, clientId, local.id);
  assert.equal(row.category, 'Marketing');
  assert.equal(row.previous_category, 'Utility');
});

test('AC8: Templates view shows the change and can filter to it (static checks)', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  assert.match(app, /function templateCategoryNote\(t\)/);
  assert.match(app, /\$\{templateCategoryNote\(t\)\}/);
  assert.match(app, /templatesView\.category === 'changed'/);
  assert.match(html, /<option value="changed">Changed by Meta<\/option>/);
  assert.equal(typeof metaClient.listTemplates, 'function');
});
