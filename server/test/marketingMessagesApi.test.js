// Marketing Messages API route (build-docs/features/marketing-messages-api.md).
// Only graph.facebook.com is faked. Local database only; disposable
// __test_suite__ client deleted in after().
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const apiKeysRepo = require('../src/repositories/apiKeysRepo');
const messageTemplatesRepo = require('../src/repositories/messageTemplatesRepo');
const messageRetryRunner = require('../src/services/messageRetryRunner');
const { encrypt } = require('../src/utils/encryption');
const { ADMIN_EMAIL, ADMIN_PASSWORD } = require('./helpers/adminCredentials');

const PREFIX = '__test_suite__mmapi_';
const WABA_ID = `test_suite_mmapi_waba_${Date.now()}`;
const PHONE_ID = `test_suite_mmapi_phone_${Date.now()}`;
const APP_SECRET = 'test-suite-mmapi-app-secret';
const MARKETING = `${PREFIX}promo`;
const UTILITY = `${PREFIX}receipt`;
const OPT_IN_METHOD = 'website_form';

let server, baseUrl, clientId, apiKey, adminToken, savedSecret, restoreFetch;
let calls = [];
let mmFails = false; // fake /marketing_messages answers 503
let mmStatus = 'ONBOARDED';
let n = 0;

before(async () => {
  savedSecret = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = APP_SECRET;
  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, options);
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) });
    if (u.includes(`/${PHONE_ID}/`)) {
      calls.push({ url: u, body: JSON.parse(options.body) });
      if (u.includes('/marketing_messages') && mmFails) return reply(503, {});
      return reply(200, { messages: [{ id: `wamid.${PREFIX}${++n}_${Date.now()}` }] });
    }
    if (u.includes(`/${WABA_ID}?fields=marketing_messages_onboarding_status`)) {
      calls.push({ url: u });
      return reply(200, { marketing_messages_onboarding_status: mmStatus, id: WABA_ID });
    }
    return reply(200, {});
  };
  restoreFetch = () => { global.fetch = realFetch; };

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://localhost:${server.address().port}`;
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${PREFIX}client`, email: `test-suite-mmapi-${Date.now()}@wasi.local`, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  clientId = reg.client.id;
  await pool.query("update clients set status = 'active', email_verified = true where id = $1", [clientId]);
  await wabasRepo.upsertForClient(clientId, {
    waba_id: WABA_ID, phone_number_id: PHONE_ID, status: 'connected', access_token_encrypted: encrypt('fake-token'),
  });
  apiKey = (await apiKeysRepo.create(pool, clientId, `${PREFIX}key`)).rawKey;
  for (const [name, category] of [[MARKETING, 'Marketing'], [UTILITY, 'Utility']]) {
    await messageTemplatesRepo.create(pool, { client_id: clientId, name, category, language: 'en_US', status: 'approved', body: 'Our new batch starts on Monday. See you there.' });
  }
  await pool.query('update message_templates set approved_at = now() where client_id = $1', [clientId]);
  const login = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  }).then((r) => r.json());
  adminToken = login.token;
  assert.ok(adminToken, 'admin login');
});

beforeEach(() => { calls = []; mmFails = false; });

after(async () => {
  restoreFetch();
  if (savedSecret === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = savedSecret;
  if (clientId) {
    await pool.query('delete from audit_log where actor_id = $1 or target like $2', [clientId, `${clientId}%`]);
    await pool.query('delete from clients where id = $1', [clientId]);
  }
  await new Promise((r) => server.close(r));
  await pool.end();
});

const admin = (p, method = 'GET', body) => fetch(`${baseUrl}/api/admin${p}`, {
  method, headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
});
const setSwitch = (enabled) => admin(`/clients/${clientId}/mm-api`, 'PATCH', { enabled });

async function send(template) {
  const res = await fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: `9190000${String(++n).padStart(5, '0')}`, type: 'template', template, optIn: { method: OPT_IN_METHOD } }),
  });
  const body = await res.json();
  assert.ok(res.status === 200 || res.status === 201 || res.status === 202, `${res.status} ${JSON.stringify(body)}`);
  const { rows } = await pool.query(
    'select * from messages where client_id = $1 and direction = $2 order by sent_at desc limit 1', [clientId, 'out']);
  return rows[0];
}

async function postStatus(metaMessageId, category) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID },
    statuses: [{ id: metaMessageId, status: 'delivered', timestamp: '1795700000', recipient_id: '919000000001', pricing: { billable: true, category } }],
  } }] }] });
  const sig = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
  const res = await fetch(`${baseUrl}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body });
  assert.equal(res.status, 200);
}

test('AC2 switch off: a Marketing template goes to /messages exactly as before', async () => {
  const row = await send(MARKETING);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, new RegExp(`/${PHONE_ID}/messages$`));
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['messaging_product', 'template', 'to', 'type']);
  assert.equal(row.send_route, null);
});

test('AC1 switch on: a Marketing template goes to /marketing_messages with Cloud API fallback', async () => {
  assert.equal((await setSwitch(true)).status, 200);
  const row = await send(MARKETING);
  assert.match(calls[0].url, new RegExp(`/v24\\.0/${PHONE_ID}/marketing_messages$`));
  assert.equal(calls[0].body.product_policy, 'CLOUD_API_FALLBACK');
  assert.equal('message_activity_sharing' in calls[0].body, false, 'left to the business setting');
  assert.equal(calls[0].body.template.name, MARKETING);
  assert.equal(row.send_route, 'mm_api');
});

test('AC2 switch on: a Utility template still goes to /messages', async () => {
  await setSwitch(true);
  const row = await send(UTILITY);
  assert.match(calls[0].url, /\/messages$/);
  assert.equal('product_policy' in calls[0].body, false);
  assert.equal(row.send_route, null);
});

test('AC5 status webhook pricing category records the real route', async () => {
  await setSwitch(true);
  const mm = await send(MARKETING);
  await postStatus(mm.meta_message_id, 'marketing');
  let { rows } = await pool.query('select send_route from messages where id = $1', [mm.id]);
  assert.equal(rows[0].send_route, 'mm_api_fallback');
  await postStatus(mm.meta_message_id, 'marketing_lite');
  ({ rows } = await pool.query('select send_route from messages where id = $1', [mm.id]));
  assert.equal(rows[0].send_route, 'mm_api');
  const util = await send(UTILITY);
  await postStatus(util.meta_message_id, 'marketing');
  ({ rows } = await pool.query('select send_route from messages where id = $1', [util.id]));
  assert.equal(rows[0].send_route, null, 'a Cloud API send is never relabelled');
});

test('AC4 "Check now" and the MM_LITE_TERMS_SIGNED webhook update the status', async () => {
  mmStatus = 'ONBOARDED';
  const res = await admin(`/clients/${clientId}/mm-api/check`, 'POST');
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.waba.mm_api_status, 'ONBOARDED');
  assert.match(calls[0].url, /\/v24\.0\//);
  assert.equal('access_token_encrypted' in body.waba, false, 'token never returned');

  const hook = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field: 'account_update', value: {
    event: 'MM_LITE_TERMS_SIGNED', waba_info: { waba_id: WABA_ID, owner_business_id: '1' },
  } }] }] });
  const sig = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(hook).digest('hex')}`;
  assert.equal((await fetch(`${baseUrl}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body: hook })).status, 200);
  const { rows } = await pool.query('select mm_api_status from wabas where waba_id = $1', [WABA_ID]);
  assert.equal(rows[0].mm_api_status, 'MM_LITE_TERMS_SIGNED');
});

test('AC6 the switch: validated, audited, full admins only; client detail shows delivery by route', async () => {
  assert.equal((await admin(`/clients/${clientId}/mm-api`, 'PATCH', { enabled: 'yes' })).status, 400);
  await setSwitch(false);
  const { rows } = await pool.query("select action from audit_log where target like $1 and action like 'mm_api_%' order by created_at desc limit 1", [`${clientId}%`]);
  assert.equal(rows[0].action, 'mm_api_disabled');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
  assert.match(src, /router\.patch\('\/clients\/:id\/mm-api', fullOnly,/);

  const detail = await admin(`/clients/${clientId}`).then((r) => r.json());
  assert.equal(detail.waba.mm_api_enabled, false);
  const byRoute = Object.fromEntries(detail.mmDeliveryByRoute.map((r) => [r.route, r]));
  assert.ok(byRoute.cloud.sent >= 1, 'Marketing sent via Cloud API counted');
  assert.ok(byRoute.mm_api.sent >= 1, 'Marketing sent via MM API counted');
  assert.ok(byRoute.mm_api.delivered >= 1);
  assert.equal(detail.mmDeliveryByRoute.some((r) => r.route === 'cloud' && r.sent > 1), false, 'Utility sends are not counted');
});

test('AC7 a queued MM send is replayed on the same route', async () => {
  await setSwitch(true);
  mmFails = true;
  const res = await fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: '919000099999', type: 'template', template: MARKETING, optIn: { method: OPT_IN_METHOD } }),
  });
  assert.equal(res.status, 202, JSON.stringify(await res.json()));
  const { rows: [row] } = await pool.query("select * from messages where client_id = $1 and status = 'pending' and send_request is not null", [clientId]);
  assert.equal(row.send_request.args[1].route, 'mm_api');
  mmFails = false;
  calls = [];
  assert.equal(await messageRetryRunner.processRow(row), 'sent');
  assert.match(calls[0].url, /\/marketing_messages$/);
  const { rows: [after] } = await pool.query('select status, send_route from messages where id = $1', [row.id]);
  assert.equal(after.status, 'sent');
  assert.equal(after.send_route, 'mm_api');
});
