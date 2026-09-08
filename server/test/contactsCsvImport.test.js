// PLAN.md item 6 — general contacts CSV import. Verifies:
// 1. 3 valid rows + 1 duplicate-phone-within-file row: correct
//    importedCount/failedCount/errors, real contacts created.
// 2. Re-uploading the same file is safe — no duplicate contacts.
// 3. Tenant isolation — imported contacts only ever land under the
//    uploading client, never leak into another client's list.
// 4. Role gating (Agent allowed, matching item 1's Contacts row) and
//    unauthenticated rejection.
// 5. No file uploaded is a clean 400, not a 500.
// 6. A file over the 5MB cap is a clean 400, not multer's unhandled 500.
// 7/7b/7c. PLAN.md item 8 fold-in: a "tags" column is now wired through
//    (real tags created/attached additively, never touching contacts.tag_id,
//    safe to re-import) — a genuinely unrecognized column (e.g. "notes")
//    still gets the "unrecognized column" notice item 6 originally added.
// Same dedicated-disposable-test-client convention as every other file in
// this directory.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;
let clientToken;
let testClientId;
let otherClientToken;
let otherClientId;

const SUITE_PREFIX = '__test_suite__contactscsv_';
const PASSWORD = 'test-suite-password-12345';

function authed(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerClient(suffix) {
  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      businessName: `${SUITE_PREFIX}client_${suffix}`,
      email: `test-suite-contactscsv-${suffix}-${Date.now()}@wasi.local`,
      password: PASSWORD,
    }),
  }).then((r) => r.json());
  return { token: registered.token, id: registered.client?.id };
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const primary = await registerClient('primary');
  clientToken = primary.token;
  testClientId = primary.id;
  assert.ok(clientToken && testClientId, 'dedicated test client registration must succeed');

  const other = await registerClient('other');
  otherClientToken = other.token;
  otherClientId = other.id;
});

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  if (otherClientId) await pool.query('delete from clients where id = $1', [otherClientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function csvFile(content) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/csv' }), 'contacts.csv');
  return form;
}

test('1. 3 valid rows + 1 duplicate-phone-within-file row: correct counts, real contacts created', async () => {
  // parseContactsCsv's isValidPhone caps at 15 digits — a plain
  // '9173' + Date.now() (13 digits) + a distinguishing suffix digit
  // overflows that (18 digits), which would make these rows fail CSV
  // validation instead of just failing to be distinct (a subtler version
  // of the same truncated-uniqueness mistake already found once this
  // session in chatSlaLogs.test.js). Using only the last 9 digits of
  // Date.now() keeps the total at 12 digits — valid, and still unique
  // enough for three calls a few milliseconds apart within one test.
  const ts = String(Date.now()).slice(-9);
  const p1 = `91${ts}1`;
  const p2 = `91${ts}2`;
  const p3 = `91${ts}3`;
  const csv = `name,phone\n${SUITE_PREFIX}A,${p1}\n${SUITE_PREFIX}B,${p2}\n${SUITE_PREFIX}C,${p3}\n${SUITE_PREFIX}Dupe,${p1}\n`;

  const res = await fetch(`${baseUrl}/api/contacts/import`, {
    method: 'POST', headers: authed(clientToken), body: csvFile(csv),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.importedCount, 3);
  assert.equal(data.failedCount, 1);
  assert.equal(data.errors.length, 1);
  assert.match(data.errors[0].reason, /duplicate/i);

  const contacts = await fetch(`${baseUrl}/api/contacts`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.ok(contacts.some((c) => c.phone === p1 && c.name === `${SUITE_PREFIX}A`));
  assert.ok(contacts.some((c) => c.phone === p2 && c.name === `${SUITE_PREFIX}B`));
  assert.ok(contacts.some((c) => c.phone === p3 && c.name === `${SUITE_PREFIX}C`));
});

test('2. re-uploading the exact same file is safe — no duplicate contacts created', async () => {
  const p = `9174${Date.now()}`.slice(0, 12);
  const csv = `name,phone\n${SUITE_PREFIX}Reimport,${p}\n`;

  const first = await fetch(`${baseUrl}/api/contacts/import`, { method: 'POST', headers: authed(clientToken), body: csvFile(csv) });
  assert.equal((await first.json()).importedCount, 1);

  const second = await fetch(`${baseUrl}/api/contacts/import`, { method: 'POST', headers: authed(clientToken), body: csvFile(csv) });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).importedCount, 1, 're-import still reports the row as processed, not an error');

  const contacts = await fetch(`${baseUrl}/api/contacts`, { headers: authed(clientToken) }).then((r) => r.json());
  const matches = contacts.filter((c) => c.phone === p);
  assert.equal(matches.length, 1, 'exactly one contact must exist for this phone, not two');
});

test('3. tenant isolation: an import never leaks contacts into another client', async () => {
  const p = `9175${Date.now()}`.slice(0, 12);
  const csv = `name,phone\n${SUITE_PREFIX}Isolated,${p}\n`;
  await fetch(`${baseUrl}/api/contacts/import`, { method: 'POST', headers: authed(clientToken), body: csvFile(csv) });

  const otherContacts = await fetch(`${baseUrl}/api/contacts`, { headers: authed(otherClientToken) }).then((r) => r.json());
  assert.ok(!otherContacts.some((c) => c.phone === p), 'the imported contact must not appear in another client\'s list');
});

test('4. role gating: Agent can import (matches item 1\'s Contacts row); unauthenticated is rejected', async () => {
  const authTokensRepo = require('../src/repositories/authTokensRepo');
  const agentCreated = await fetch(`${baseUrl}/api/team-members`, {
    method: 'POST', headers: { ...authed(clientToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${SUITE_PREFIX}Agent`, email: `${SUITE_PREFIX}agent-${Date.now()}@wasi.local`, role: 'Agent' }),
  }).then((r) => r.json());
  const inviteToken = await authTokensRepo.create('team_member', agentCreated.id, 'team_invite', 60);
  const accepted = await fetch(`${baseUrl}/api/auth/team/accept-invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inviteToken, password: PASSWORD }),
  }).then((r) => r.json());

  const p = `9176${Date.now()}`.slice(0, 12);
  const csv = `name,phone\n${SUITE_PREFIX}ByAgent,${p}\n`;
  const asAgent = await fetch(`${baseUrl}/api/contacts/import`, { method: 'POST', headers: authed(accepted.token), body: csvFile(csv) });
  assert.equal(asAgent.status, 200);

  const unauth = await fetch(`${baseUrl}/api/contacts/import`, { method: 'POST', body: csvFile(csv) });
  assert.equal(unauth.status, 401);
});

test('5. no file uploaded is a clean 400, not a 500', async () => {
  const res = await fetch(`${baseUrl}/api/contacts/import`, { method: 'POST', headers: authed(clientToken), body: new FormData() });
  assert.equal(res.status, 400);
});

test('6. a file over the 5MB cap is a clean 400, not a 500', async () => {
  // 6MB of padding is enough to trip multer's fileSize limit before the
  // request body is ever fully read — the padding content itself doesn't
  // need to be valid CSV, since multer rejects on size alone.
  const oversized = 'name,phone\n' + 'x'.repeat(6 * 1024 * 1024);
  const res = await fetch(`${baseUrl}/api/contacts/import`, { method: 'POST', headers: authed(clientToken), body: csvFile(oversized) });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /too large/i);
});

test('7. PLAN.md item 8 fold-in: a "tags" column is now wired through — real tags created/attached, no longer "unrecognized"', async () => {
  const ts = String(Date.now()).slice(-9);
  const p = `93${ts}1`;
  const csv = `name,phone,tags\n${SUITE_PREFIX}Tagged,${p},${SUITE_PREFIX}VIP;${SUITE_PREFIX}Repeat\n`;

  const res = await fetch(`${baseUrl}/api/contacts/import`, { method: 'POST', headers: authed(clientToken), body: csvFile(csv) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.importedCount, 1, 'the name/phone row still imports');
  assert.equal(data.failedCount, 0);
  assert.equal(data.errors.length, 0, '"tags" is a known column now — no "unrecognized column" notice');

  const contacts = await fetch(`${baseUrl}/api/contacts`, { headers: authed(clientToken) }).then((r) => r.json());
  const imported = contacts.find((c) => c.phone === p && c.name === `${SUITE_PREFIX}Tagged`);
  assert.ok(imported);
  assert.equal(imported.tag_id, null, 'CSV-imported tags must never set the primary tag_id (additive only)');

  const tags = await fetch(`${baseUrl}/api/contacts/${imported.id}/tags`, { headers: authed(clientToken) }).then((r) => r.json());
  const names = tags.tags.map((t) => t.name).sort();
  assert.deepEqual(names, [`${SUITE_PREFIX}Repeat`, `${SUITE_PREFIX}VIP`].sort());
});

test('7b. re-importing the same row (same tags) is safe — no duplicate tag or duplicate attachment', async () => {
  const ts = String(Date.now()).slice(-9);
  const p = `93${ts}2`;
  const csv = `name,phone,tags\n${SUITE_PREFIX}Reimport,${p},${SUITE_PREFIX}Loyal\n`;

  await fetch(`${baseUrl}/api/contacts/import`, { method: 'POST', headers: authed(clientToken), body: csvFile(csv) });
  const second = await fetch(`${baseUrl}/api/contacts/import`, { method: 'POST', headers: authed(clientToken), body: csvFile(csv) });
  assert.equal(second.status, 200);

  const contacts = await fetch(`${baseUrl}/api/contacts`, { headers: authed(clientToken) }).then((r) => r.json());
  const imported = contacts.find((c) => c.phone === p);
  const tags = await fetch(`${baseUrl}/api/contacts/${imported.id}/tags`, { headers: authed(clientToken) }).then((r) => r.json());
  assert.equal(tags.tags.length, 1, 'no duplicate tag or duplicate attachment from re-importing the same file');
  assert.equal(tags.tags[0].name, `${SUITE_PREFIX}Loyal`);
});

test('7c. a genuinely unrecognized column is still reported (e.g. "notes"), unlike "tags" now', async () => {
  const ts = String(Date.now()).slice(-9);
  const p = `93${ts}3`;
  const csv = `name,phone,notes\n${SUITE_PREFIX}Noted,${p},some notes\n`;

  const res = await fetch(`${baseUrl}/api/contacts/import`, { method: 'POST', headers: authed(clientToken), body: csvFile(csv) });
  const data = await res.json();
  assert.equal(data.importedCount, 1);
  assert.equal(data.failedCount, 0);
  assert.equal(data.errors.length, 1);
  assert.match(data.errors[0].reason, /"notes".*not imported/i);
});
