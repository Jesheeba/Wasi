// Contact Lists (wasi-master-plan.md §8.3) — CSV import route, real DB.
// Same dedicated-disposable-test-client pattern as apiKeysSelfServe.test.js.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;
let clientToken;
let testClientId;

const SUITE_PREFIX = '__test_suite__contactlists_';

function authed(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client`,
      email: `test-suite-contactlists-${Date.now()}@wasi.local`,
      password: 'test-suite-password-12345',
    }),
  }).then((r) => r.json());
  clientToken = registered.token;
  testClientId = registered.client?.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function csvUploadBody(name, csvText, filename = 'contacts.csv') {
  const boundary = '----WasiTestBoundary' + Date.now();
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: text/csv',
    '',
    csvText,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

test('POST /api/contact-lists: creates an empty list', async () => {
  const res = await fetch(`${baseUrl}/api/contact-lists`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}list1` }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.name, `${SUITE_PREFIX}list1`);
  assert.equal(data.source, 'manual');
});

test('POST /:id/import: valid CSV creates new contacts and list membership; malformed rows are reported, not silently dropped', async () => {
  const created = await fetch(`${baseUrl}/api/contact-lists`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}import_target` }),
  }).then((r) => r.json());

  const phoneA = `9198${Date.now()}`.slice(0, 12);
  const phoneB = `9197${Date.now()}`.slice(0, 12);
  const csv = [
    'name,phone',
    `Import A,${phoneA}`,
    `Import B,${phoneB}`,
    'Bad Row,12345',
  ].join('\n');
  const { body, contentType } = csvUploadBody('file', csv);

  const res = await fetch(`${baseUrl}/api/contact-lists/${created.id}/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': contentType },
    body,
  });
  assert.equal(res.status, 200);
  const report = await res.json();
  assert.equal(report.imported, 2);
  assert.equal(report.rejected, 1);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0].reason, /not a valid phone number/i);

  const members = await pool.query(
    `select c.phone from contact_list_members clm join contacts c on c.id = clm.contact_id where clm.contact_list_id = $1`,
    [created.id]
  );
  const phones = members.rows.map((r) => r.phone).sort();
  assert.deepEqual(phones, [phoneA, phoneB].sort());
});

test('POST /:id/import: dedups against an existing contact by phone instead of creating a duplicate', async () => {
  const existingPhone = `9196${Date.now()}`.slice(0, 12);
  const contactRes = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: 'Already A Contact', phone: existingPhone }),
  }).then((r) => r.json());

  const list = await fetch(`${baseUrl}/api/contact-lists`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}dedup_target` }),
  }).then((r) => r.json());

  const csv = `name,phone\nRe-imported Name,${existingPhone}`;
  const { body, contentType } = csvUploadBody('file', csv);
  await fetch(`${baseUrl}/api/contact-lists/${list.id}/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': contentType },
    body,
  });

  const contactCount = await pool.query('select count(*)::int as n from contacts where client_id = $1 and phone = $2', [testClientId, existingPhone]);
  assert.equal(contactCount.rows[0].n, 1, 'must not create a second contact row for a phone that already exists');

  const membership = await pool.query(
    'select 1 from contact_list_members where contact_list_id = $1 and contact_id = $2',
    [list.id, contactRes.id]
  );
  assert.equal(membership.rows.length, 1, 'the existing contact must be linked as a list member');
});

test('POST /:id/import: re-importing the same file is safe (no duplicate membership, no error)', async () => {
  const list = await fetch(`${baseUrl}/api/contact-lists`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}reimport_target` }),
  }).then((r) => r.json());

  const phone = `9195${Date.now()}`.slice(0, 12);
  const csv = `name,phone\nRepeat,${phone}`;

  for (let i = 0; i < 2; i++) {
    const { body, contentType } = csvUploadBody('file', csv);
    const res = await fetch(`${baseUrl}/api/contact-lists/${list.id}/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': contentType },
      body,
    });
    assert.equal(res.status, 200);
  }

  const memberCount = await pool.query('select count(*)::int as n from contact_list_members where contact_list_id = $1', [list.id]);
  assert.equal(memberCount.rows[0].n, 1, 'importing the same phone twice must not create two membership rows');
});

test('POST /:id/import: 404 for a list that does not belong to this client', async () => {
  const { body, contentType } = csvUploadBody('file', 'name,phone\nX,919000000099');
  const res = await fetch(`${baseUrl}/api/contact-lists/00000000-0000-0000-0000-000000000099/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': contentType },
    body,
  });
  assert.equal(res.status, 404);
});

test('POST /:id/import: no file uploaded is rejected with a clear error, not a 500', async () => {
  const list = await fetch(`${baseUrl}/api/contact-lists`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({ name: `${SUITE_PREFIX}nofile_target` }),
  }).then((r) => r.json());

  const res = await fetch(`${baseUrl}/api/contact-lists/${list.id}/import`, {
    method: 'POST',
    headers: authed(clientToken),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('GET /api/contact-lists: shows real member counts', async () => {
  const res = await fetch(`${baseUrl}/api/contact-lists`, { headers: authed(clientToken) });
  assert.equal(res.status, 200);
  const data = await res.json();
  const importTarget = data.find((l) => l.name === `${SUITE_PREFIX}import_target`);
  assert.ok(importTarget);
  assert.equal(importTarget.member_count, 2);
});
