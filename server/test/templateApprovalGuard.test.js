// Only Meta-approved templates can be sent (build-docs/features/template-approval-guard.md).
// Only graph.facebook.com is faked. Runs against TEST_DATABASE_URL (a local
// database), never the shared production one.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');
const apiKeysRepo = require('../src/repositories/apiKeysRepo');
const messageTemplatesRepo = require('../src/repositories/messageTemplatesRepo');
const { encrypt } = require('../src/utils/encryption');

const SUITE_PREFIX = '__test_suite__tplappr_';
const WABA_ID = 'test_suite_tplappr_waba';
const PHONE_ID = 'test_suite_tplappr_phone';

let server;
let baseUrl;
let clientId;
let clientToken;
let apiKey;
let metaStatuses = {}; // meta_template_id -> what the fake GET /{id}?fields=status returns
let sends = [];
let restoreFetch;

before(async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, options);
    const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
    if (u.includes(`${PHONE_ID}/messages`)) {
      sends.push(JSON.parse(options.body));
      return ok({ messages: [{ id: `wamid.${SUITE_PREFIX}${sends.length}_${Date.now()}` }] });
    }
    const m = /\/v[\d.]+\/([^/?]+)\?fields=status/.exec(u);
    if (m && metaStatuses[m[1]]) return ok({ id: m[1], status: metaStatuses[m[1]] });
    return ok({});
  };
  restoreFetch = () => { global.fetch = realFetch; };

  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `${SUITE_PREFIX}client`, email: `test-suite-tplappr-${Date.now()}@wasi.local`, password: 'test-suite-password-12345' }),
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

beforeEach(() => { sends = []; metaStatuses = {}; });

after(async () => {
  restoreFetch();
  if (clientId) {
    await pool.query('delete from audit_log where actor_id = $1 or target like $2', [clientId, `${clientId}%`]);
    await pool.query('delete from clients where id = $1', [clientId]);
  }
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function template(name, status, { metaId = null, language = 'en_US', approvedBefore = false } = {}) {
  const row = await messageTemplatesRepo.create(pool, {
    client_id: clientId, name, category: 'Utility', language, status,
    body: 'Your registration is confirmed. Reply here if anything changes.', meta_template_id: metaId,
  });
  if (approvedBefore) await pool.query('update message_templates set approved_at = now() - interval \'1 day\' where id = $1', [row.id]);
  return row;
}

function hubSend(name) {
  return fetch(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, to: '919000000101', type: 'template', template: name }),
  });
}

async function messageRows(name) {
  const { rows } = await pool.query('select id from messages where client_id = $1 and body = $2', [clientId, `[template: ${name}]`]);
  return rows.length;
}

test('AC1: a template still waiting for Meta review is refused (409 template_not_approved), nothing reaches Meta, no message row', async () => {
  const name = `${SUITE_PREFIX}pending`;
  await template(name, 'pending', { metaId: 'META_APPR_1' });
  metaStatuses.META_APPR_1 = 'PENDING';
  const res = await hubSend(name);
  const body = await res.json();
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.error.code, 'template_not_approved');
  assert.match(body.error.message, /waiting for Meta's review/);
  assert.equal(sends.length, 0);
  assert.equal(await messageRows(name), 0);
});

test('AC2: rejected, paused and disabled templates are refused', async () => {
  for (const status of ['rejected', 'paused', 'disabled']) {
    const name = `${SUITE_PREFIX}${status}`;
    await template(name, status);
    const res = await hubSend(name);
    const body = await res.json();
    assert.equal(res.status, 409, `${status}: ${JSON.stringify(body)}`);
    assert.equal(body.error.code, 'template_not_approved');
  }
  assert.equal(sends.length, 0);
});

test('AC3: an approved template that was edited (pending re-review) still sends - Meta keeps the old version live', async () => {
  const name = `${SUITE_PREFIX}edited`;
  await template(name, 'pending', { approvedBefore: true });
  const res = await hubSend(name);
  assert.equal(res.status, 201, JSON.stringify(await res.json()));
  assert.equal(sends.length, 1);
});

test('AC4: a stale local "pending" that Meta has approved is re-checked live, sent, and stored as approved', async () => {
  const name = `${SUITE_PREFIX}stale`;
  const row = await template(name, 'pending', { metaId: 'META_APPR_4' });
  metaStatuses.META_APPR_4 = 'APPROVED';
  const res = await hubSend(name);
  assert.equal(res.status, 201, JSON.stringify(await res.json()));
  assert.equal(sends.length, 1);
  const after = await messageTemplatesRepo.findById(pool, clientId, row.id);
  assert.equal(after.status, 'approved');
  assert.ok(after.approved_at);
});

test('AC5: approved_at is stamped when a row becomes approved and kept when it is edited', async () => {
  const row = await template(`${SUITE_PREFIX}stamp`, 'pending');
  assert.equal(row.approved_at, null);
  await pool.query('update message_templates set status = \'approved\' where id = $1', [row.id]);
  const approved = await messageTemplatesRepo.findById(pool, clientId, row.id);
  assert.ok(approved.approved_at);
  const edited = await messageTemplatesRepo.updateContent(pool, clientId, row.id, { body: 'Edited body text for the confirmation message here.', category: 'Utility' });
  assert.equal(edited.status, 'pending');
  assert.equal(new Date(edited.approved_at).getTime(), new Date(approved.approved_at).getTime());
});

test('AC6: a newer pending language variant does not shadow the approved template of the same name', async () => {
  const name = `${SUITE_PREFIX}multilang`;
  await template(name, 'approved', { language: 'en_US' });
  await template(name, 'pending', { language: 'ta' });
  const found = await messageTemplatesRepo.findByNameAndClient(pool, clientId, name);
  assert.equal(found.language, 'en_US');
  const res = await hubSend(name);
  assert.equal(res.status, 201, JSON.stringify(await res.json()));
  assert.equal(sends[0].template.language.code, 'en_US');
});

test('AC7: a broadcast cannot be created with an unapproved template', async () => {
  const name = `${SUITE_PREFIX}bcast`;
  await template(name, 'pending');
  const res = await fetch(`${baseUrl}/api/broadcasts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `${SUITE_PREFIX}b`, templateName: name }),
  });
  const body = await res.json();
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(body.error, /not approved by Meta/);
});
