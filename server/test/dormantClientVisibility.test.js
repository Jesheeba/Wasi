// Task B — "make a dormant client visible." Stubs only, per direct
// instruction (production has 6 live clients sending real WhatsApp
// messages) — nothing here ever reaches the real database.
// pool.js's DB-safety guard moved to call-time (2026-09-25, see its own
// module comment), so requiring pool.js/alertRunner.js is safe on its own;
// this file goes one step further and replaces pool.query itself with a
// stub before any test runs, so the guard's real check-and-connect path is
// never exercised at all, not merely permitted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db/pool');
const alertRunner = require('../src/services/alertRunner');
const clientsRepo = require('../src/repositories/clientsRepo');

function stubPoolQuery(rows) {
  const original = pool.query;
  pool.query = async () => ({ rows });
  return () => { pool.query = original; };
}

test('alertRunner.checkDormantNoOutbound: flags a connected client with real inbound traffic and zero outbound replies in 7 days', async () => {
  const restore = stubPoolQuery([
    { waba_row_id: 'w1', waba_id: '1', client_id: 'c1', client_name: 'Dormant Co', inbound_7d: 42, outbound_7d: 0 },
    { waba_row_id: 'w2', waba_id: '2', client_id: 'c2', client_name: 'Healthy Co', inbound_7d: 10, outbound_7d: 5 },
    { waba_row_id: 'w3', waba_id: '3', client_id: 'c3', client_name: 'Quiet Co', inbound_7d: 0, outbound_7d: 0 },
  ]);
  try {
    const candidates = await alertRunner.checkDormantNoOutbound();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].dedupKey, 'c1');
    assert.equal(candidates[0].severity, 'critical');
    assert.match(candidates[0].message, /Dormant Co/);
    assert.match(candidates[0].message, /42 inbound/);
  } finally {
    restore();
  }
});

test('alertRunner.checkDormantNoOutbound: a client with zero inbound traffic is not flagged — silence isn\'t the same as unanswered', async () => {
  const restore = stubPoolQuery([
    { waba_row_id: 'w1', waba_id: '1', client_id: 'c1', client_name: 'No Traffic Co', inbound_7d: 0, outbound_7d: 0 },
  ]);
  try {
    const candidates = await alertRunner.checkDormantNoOutbound();
    assert.equal(candidates.length, 0);
  } finally {
    restore();
  }
});

test('alertRunner.checkNeverLoggedInStale: flags a connected-3+-days client with no recorded login', async () => {
  const connectedSince = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const restore = stubPoolQuery([
    { client_id: 'c1', client_name: 'Ghost Co', connected_since: connectedSince },
  ]);
  try {
    const candidates = await alertRunner.checkNeverLoggedInStale();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].dedupKey, 'c1');
    assert.equal(candidates[0].severity, 'warning');
    assert.match(candidates[0].message, /Ghost Co/);
    assert.match(candidates[0].message, /never logged in|nobody has ever logged/i);
  } finally {
    restore();
  }
});

test('alertRunner.checkNeverLoggedInStale: an empty result (nobody matches — the SQL itself already excludes recent/logged-in clients) produces no candidates', async () => {
  const restore = stubPoolQuery([]);
  try {
    const candidates = await alertRunner.checkNeverLoggedInStale();
    assert.deepEqual(candidates, []);
  } finally {
    restore();
  }
});

test('clientsRepo.touchLastLogin: issues an update against the given db handle only — no assumption about which pool', async () => {
  const calls = [];
  const stubDb = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  await clientsRepo.touchLastLogin(stubDb, 'client-123');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /update clients set last_login_at = now\(\)/i);
  assert.deepEqual(calls[0].params, ['client-123']);
});

test('clientsRepo SAFE_COLUMNS includes last_login_at so an owner\'s own-profile read (req.db, the restricted wasi_app role) can see it', async () => {
  const calls = [];
  const stubDb = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 'client-123', last_login_at: null }] }; } };
  await clientsRepo.findById(stubDb, 'client-123');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /last_login_at/);
});
