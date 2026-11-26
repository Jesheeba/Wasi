// Bulk tagging from the Contacts selection bar (build-docs/features/contacts-bulk-tags.md).
// Real DB (run against a local embedded Postgres), dedicated disposable test
// client, no Meta call reachable.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server, baseUrl, token, clientId, otherToken;
const PASSWORD = 'test-suite-password-12345';
let n = 0;
const phone = () => `9174${Date.now()}${++n}`;
const authed = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

async function api(t, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: authed(t), body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
async function register(label) {
  const r = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: `__test_suite__bulktags_${label}`, email: `test-suite-bulktags-${label}-${Date.now()}@wasi.local`, password: PASSWORD }),
  }).then((x) => x.json());
  return r;
}
const contactTagIds = async (id) => (await api(token, 'GET', '/api/contacts')).data.find((c) => c.id === id).tag_ids;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://localhost:${server.address().port}`;
  const a = await register('a');
  token = a.token; clientId = a.client.id;
  otherToken = (await register('b')).token;
});

after(async () => {
  await pool.query("delete from clients where name like '__test_suite__bulktags_%'");
  server.close();
  await pool.end();
});

test('AC1 add: tags every selected contact, idempotent, reports changed vs already-tagged', async () => {
  const tag = (await api(token, 'POST', '/api/tags', { name: 'VIP' })).data;
  const c1 = (await api(token, 'POST', '/api/contacts', { name: 'One', phone: phone() })).data;
  const c2 = (await api(token, 'POST', '/api/contacts', { name: 'Two', phone: phone() })).data;
  const c3 = (await api(token, 'POST', '/api/contacts', { name: 'Three', phone: phone() })).data;

  const first = await api(token, 'POST', '/api/contacts/bulk-tags', { contactIds: [c1.id, c2.id], tagId: tag.id, action: 'add' });
  assert.equal(first.status, 200);
  assert.deepEqual([first.data.selected, first.data.changed], [2, 2]);

  const second = await api(token, 'POST', '/api/contacts/bulk-tags', { contactIds: [c1.id, c2.id, c3.id, c3.id], tagId: tag.id, action: 'add' });
  assert.deepEqual([second.data.selected, second.data.changed], [3, 1], 'duplicates deduped, already-tagged not counted');

  for (const c of [c1, c2, c3]) assert.deepEqual(await contactTagIds(c.id), [tag.id]);
});

test('AC2 list: GET /api/contacts returns tag_ids including multiple tags', async () => {
  const t1 = (await api(token, 'POST', '/api/tags', { name: 'Lead' })).data;
  const t2 = (await api(token, 'POST', '/api/tags', { name: 'Chennai' })).data;
  const c = (await api(token, 'POST', '/api/contacts', { name: 'Multi', phone: phone() })).data;
  await api(token, 'POST', '/api/contacts/bulk-tags', { contactIds: [c.id], tagId: t1.id, action: 'add' });
  await api(token, 'POST', '/api/contacts/bulk-tags', { contactIds: [c.id], tagId: t2.id, action: 'add' });
  assert.deepEqual((await contactTagIds(c.id)).sort(), [t1.id, t2.id].sort());
  const fresh = (await api(token, 'POST', '/api/contacts', { name: 'None', phone: phone() })).data;
  assert.deepEqual(await contactTagIds(fresh.id), []);
});

test('AC3 remove: detaches the tag and clears it as primary tag', async () => {
  const tag = (await api(token, 'POST', '/api/tags', { name: 'Old' })).data;
  const primary = (await api(token, 'POST', '/api/contacts', { name: 'Primary', phone: phone(), tag_id: tag.id })).data;
  const chip = (await api(token, 'POST', '/api/contacts', { name: 'Chip', phone: phone() })).data;
  const untagged = (await api(token, 'POST', '/api/contacts', { name: 'Untagged', phone: phone() })).data;
  await api(token, 'POST', '/api/contacts/bulk-tags', { contactIds: [chip.id], tagId: tag.id, action: 'add' });

  const res = await api(token, 'POST', '/api/contacts/bulk-tags', { contactIds: [primary.id, chip.id, untagged.id], tagId: tag.id, action: 'remove' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.data.selected, res.data.changed], [3, 2]);
  const rows = (await api(token, 'GET', '/api/contacts')).data;
  const p = rows.find((c) => c.id === primary.id);
  assert.equal(p.tag_id, null);
  assert.deepEqual(p.tag_ids, []);
  assert.deepEqual(rows.find((c) => c.id === chip.id).tag_ids, []);
});

test('AC4 validation: bad action, empty list, non-uuid -> 400; unknown tag -> 404', async () => {
  const tag = (await api(token, 'POST', '/api/tags', { name: 'Val' })).data;
  const c = (await api(token, 'POST', '/api/contacts', { name: 'V', phone: phone() })).data;
  assert.equal((await api(token, 'POST', '/api/contacts/bulk-tags', { contactIds: [c.id], tagId: tag.id, action: 'toggle' })).status, 400);
  assert.equal((await api(token, 'POST', '/api/contacts/bulk-tags', { contactIds: [], tagId: tag.id, action: 'add' })).status, 400);
  assert.equal((await api(token, 'POST', '/api/contacts/bulk-tags', { contactIds: ['nope'], tagId: tag.id, action: 'add' })).status, 400);
  assert.equal((await api(token, 'POST', '/api/contacts/bulk-tags', { contactIds: [c.id], tagId: '00000000-0000-0000-0000-000000000000', action: 'add' })).status, 404);
});

test('AC5 tenant isolation: another client cannot tag my contacts or use my tag', async () => {
  const tag = (await api(token, 'POST', '/api/tags', { name: 'Mine' })).data;
  const c = (await api(token, 'POST', '/api/contacts', { name: 'Mine', phone: phone() })).data;
  const otherTag = (await api(otherToken, 'POST', '/api/tags', { name: 'Theirs' })).data;

  assert.equal((await api(otherToken, 'POST', '/api/contacts/bulk-tags', { contactIds: [c.id], tagId: tag.id, action: 'add' })).status, 404);
  const res = await api(otherToken, 'POST', '/api/contacts/bulk-tags', { contactIds: [c.id], tagId: otherTag.id, action: 'add' });
  assert.equal(res.status, 200);
  assert.equal(res.data.changed, 0, 'a foreign contact id is silently skipped');
  assert.deepEqual(await contactTagIds(c.id), []);
});

test('AC6 auth: no token -> 401', async () => {
  const res = await fetch(`${baseUrl}/api/contacts/bulk-tags`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  void clientId;
});
