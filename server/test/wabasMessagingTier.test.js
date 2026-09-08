// PLAN.md item 13 — messaging tier tracking, migration only. Verifies:
// 1. The migration applied cleanly — wabas.messaging_tier exists, is
//    nullable, and a real WABA row can be created/read with it left null.
// 2. Nothing that already reads a wabas row breaks with the new column
//    always null — wabasRepo.findByClientId (select *) still returns a
//    normal row shape.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db/pool');
const wabasRepo = require('../src/repositories/wabasRepo');

const SUITE_PREFIX = '__test_suite__wabasmessagingtier_';
let testClientId;

after(async () => {
  if (testClientId) await pool.query('delete from clients where id = $1', [testClientId]);
  await pool.end();
});

test('1. wabas.messaging_tier exists, is nullable, and a real row can be created/read with it null', async () => {
  const client = await pool.query(
    `insert into clients (name, email, tenant_slug) values ($1, $2, $3) returning id`,
    [`${SUITE_PREFIX}client`, `${SUITE_PREFIX}${Date.now()}@wasi.local`, `${SUITE_PREFIX}${Date.now()}`]
  ).then((r) => r.rows[0]);
  testClientId = client.id;

  const waba = await wabasRepo.upsertForClient(testClientId, {
    waba_id: `${SUITE_PREFIX}waba`,
    phone_number_id: `${SUITE_PREFIX}phone`,
    status: 'connected',
  });
  assert.ok('messaging_tier' in waba, 'the column must be present on the real returned row');
  assert.equal(waba.messaging_tier, null, 'unpopulated until the follow-up fetch work lands, per this item\'s own explicit scope');
});

test('2. an existing read path (wabasRepo.findByClientId, a plain select *) is unaffected by the new always-null column', async () => {
  const found = await wabasRepo.findByClientId(testClientId);
  assert.ok(found);
  assert.equal(found.messaging_tier, null);
});
