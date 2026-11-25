// Hub API phone validation (build-docs/features/hub-api-phone-validation.md).
// Production had contacts with phone "undefined", "not-a-number" and a real
// number carrying an invisible U+202C - all stored as-is by the Hub API.
// Disposable client, no WABA: a valid send stops at waba_not_connected / a
// consent check, never at Meta.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const apiKeysRepo = require('../src/repositories/apiKeysRepo');
const { normalizePhone, isValidPhone } = require('../src/utils/csvContacts');

let server, BASE, clientId, apiKey;
const post = (path, body) => fetch(`${BASE}${path}`, {
  method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));
const contactCount = async () => (await pool.query('select count(*)::int n from contacts where client_id = $1', [clientId])).rows[0].n;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://localhost:${server.address().port}`;
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: '__test_suite__phone client', email: `test-phone-${Date.now()}@wasi.local`, password: 'test-suite-password-12345' }),
  }).then((r) => r.json());
  clientId = reg.client.id;
  apiKey = (await apiKeysRepo.create(pool, clientId, '__test_suite__phone')).rawKey;
});

after(async () => {
  if (clientId) {
    await pool.query("delete from audit_log where actor_type = 'client' and actor_id = $1", [clientId]);
    await pool.query('delete from clients where id = $1', [clientId]);
  }
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('normalizePhone strips spaces, dashes, brackets, a leading + and invisible characters', () => {
  assert.equal(normalizePhone('+91 99406-58027'), '919940658027');
  assert.equal(normalizePhone('(91) 99406 58027'), '919940658027');
  assert.equal(normalizePhone('9976311586‬'), '9976311586');
  assert.equal(normalizePhone('‎919940658027﻿'), '919940658027');
  assert.equal(normalizePhone(undefined), '');
  assert.equal(isValidPhone('919940658027'), true);
  assert.equal(isValidPhone('undefined'), false);
  assert.equal(isValidPhone('12345'), false);
});

test('send: "undefined", text and too-short numbers are refused with invalid_phone and create no contact', async () => {
  const before = await contactCount();
  for (const to of ['undefined', 'not-a-number', 'x', '12345', ' ']) {
    const r = await post('/api/v1/messages', { client_id: clientId, to, type: 'text', body: 'hi' });
    assert.equal(r.status, 400, `to=${JSON.stringify(to)}`);
    assert.equal(r.data.error.code, 'invalid_phone');
  }
  const r = await post('/api/v1/messages', { client_id: clientId, to: 'undefined', type: 'text', body: 'hi' });
  assert.match(r.data.error.message, /Received "undefined"/);
  assert.match(r.data.error.message, /field your automation reads does not exist/);
  assert.equal(await contactCount(), before, 'no junk contact was created');
});

test('send: a formatted number with an invisible character is cleaned and stored digits-only', async () => {
  const raw = '+91 99406-5‬8099';
  const r = await post('/api/v1/messages', { client_id: clientId, to: raw, type: 'text', body: 'hi' });
  assert.notEqual(r.data.error?.code, 'invalid_phone');
  const { rows } = await pool.query('select phone from contacts where client_id = $1 and phone = $2', [clientId, '919940658099']);
  assert.equal(rows.length, 1);
});

test('consent: invalid phone is refused; a formatted one is cleaned; lookup by a formatted number finds it', async () => {
  const bad = await post('/api/v1/contacts/consent', { phone: 'undefined', status: 'opted_out' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'invalid_phone');

  const ok = await post('/api/v1/contacts/consent', { phone: '+91 98765-00011', status: 'opted_out' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.phone, '919876500011');

  const found = await fetch(`${BASE}/api/v1/contacts?phone=${encodeURIComponent('+91 98765 00011')}`, { headers: { Authorization: `Bearer ${apiKey}` } }).then((r) => r.json());
  assert.equal(found.length, 1);
  assert.equal(found[0].phone, '919876500011');
});
