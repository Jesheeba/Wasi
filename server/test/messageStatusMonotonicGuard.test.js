// Monotonic status guard for chatsRepo.updateStatusByMetaId, added
// 2026-09-25 — not echo-specific (WhatsApp status webhooks aren't
// guaranteed to arrive in order for any outbound message), but made urgent
// by coexistence echo ingestion: an echo starts at 'delivered' immediately,
// so a later 'sent' webhook for the same id would previously have silently
// regressed it. Stubs only — decideStatusTransition is pure (no DB at all);
// the updateStatusByMetaId tests use a fake `db.query`, same pattern as
// coexistenceEchoIngestion.test.js.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const chatsRepo = require('../src/repositories/chatsRepo');

const { decideStatusTransition } = chatsRepo;

// --- decideStatusTransition: the ladder itself ---

test('decideStatusTransition: sent -> delivered -> read all move forward and are accepted', () => {
  assert.equal(decideStatusTransition('sent', 'delivered').accept, true);
  assert.equal(decideStatusTransition('sent', 'read').accept, true, 'a skipped intermediate status (sent straight to read) is still a forward move');
  assert.equal(decideStatusTransition('delivered', 'read').accept, true);
});

test('decideStatusTransition: an out-of-order status moving backward is rejected and logged', () => {
  const d1 = decideStatusTransition('delivered', 'sent');
  assert.equal(d1.accept, false);
  assert.ok(d1.reason, 'a real backward move must carry a log reason');

  const d2 = decideStatusTransition('read', 'delivered');
  assert.equal(d2.accept, false);
  assert.ok(d2.reason);

  const d3 = decideStatusTransition('read', 'sent');
  assert.equal(d3.accept, false);
  assert.ok(d3.reason);
});

test('decideStatusTransition: an exact repeat of the current status is rejected without a log (normal redelivery, not an anomaly)', () => {
  const d = decideStatusTransition('delivered', 'delivered');
  assert.equal(d.accept, false);
  assert.equal(d.reason, undefined, 'a redelivered duplicate status is expected Meta behavior, not worth logging');
});

test("decideStatusTransition: 'failed' is accepted while the row isn't already delivered/read", () => {
  assert.equal(decideStatusTransition('pending', 'failed').accept, true);
  assert.equal(decideStatusTransition('sent', 'failed').accept, true);
  assert.equal(decideStatusTransition('failed', 'failed').accept, true, 'a redelivered failed status is still accepted (idempotent no-op write)');
});

test("decideStatusTransition: 'failed' is rejected once the row is already delivered or read — logged as an anomaly", () => {
  const d1 = decideStatusTransition('delivered', 'failed');
  assert.equal(d1.accept, false);
  assert.ok(d1.reason);

  const d2 = decideStatusTransition('read', 'failed');
  assert.equal(d2.accept, false);
  assert.ok(d2.reason);
});

test("decideStatusTransition: 'pending' is never accepted from a webhook, regardless of current status", () => {
  for (const current of ['pending', 'sent', 'delivered', 'read', 'failed']) {
    const d = decideStatusTransition(current, 'pending');
    assert.equal(d.accept, false, `pending must never be accepted (current=${current})`);
    assert.ok(d.reason);
  }
});

test('decideStatusTransition: an unrecognized status value is accepted as-is (never silently dropped)', () => {
  const d = decideStatusTransition('sent', 'some_new_meta_status');
  assert.equal(d.accept, true);
});

// --- updateStatusByMetaId: SQL/params wiring around the guard ---

function fakeDb({ currentStatus }) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/^select status from messages/.test(sql)) {
        return { rows: currentStatus === undefined ? [] : [{ status: currentStatus }] };
      }
      if (/^update messages set/.test(sql)) {
        return { rows: [{ id: 'msg-1' }] };
      }
      return { rows: [] };
    },
  };
}

test('updateStatusByMetaId: an accepted forward transition writes the incoming status', async () => {
  const db = fakeDb({ currentStatus: 'sent' });
  await chatsRepo.updateStatusByMetaId(db, 'client-1', 'wamid.A', 'delivered', null, null);
  const updateCall = db.queries.find((q) => /^update messages set/.test(q.sql));
  assert.equal(updateCall.params[2], 'delivered', 'status column value must be the incoming status');
});

test('updateStatusByMetaId: a blocked out-of-order transition writes the CURRENT status back, not the incoming one', async () => {
  const db = fakeDb({ currentStatus: 'delivered' });
  await chatsRepo.updateStatusByMetaId(db, 'client-1', 'wamid.B', 'sent', null, null);
  const updateCall = db.queries.find((q) => /^update messages set/.test(q.sql));
  assert.equal(updateCall.params[2], 'delivered', 'a rejected transition must leave status unchanged, not regress it to the incoming value');
});

test('updateStatusByMetaId: a blocked failed (already delivered) does not pass error detail into the update', async () => {
  const db = fakeDb({ currentStatus: 'delivered' });
  await chatsRepo.updateStatusByMetaId(db, 'client-1', 'wamid.C', 'failed', 'Some Meta error', 131047);
  const updateCall = db.queries.find((q) => /^update messages set/.test(q.sql));
  assert.equal(updateCall.params[2], 'delivered', 'status must stay delivered');
  assert.equal(updateCall.params[6], false, 'recordFailureDetail must be false — no error_reason/meta_error_code/failed_at write for an anomalous failed-after-delivered');
});

test('updateStatusByMetaId: an accepted failed (not yet delivered/read) does pass error detail into the update', async () => {
  const db = fakeDb({ currentStatus: 'sent' });
  await chatsRepo.updateStatusByMetaId(db, 'client-1', 'wamid.D', 'failed', 'Recipient unavailable', 131026);
  const updateCall = db.queries.find((q) => /^update messages set/.test(q.sql));
  assert.equal(updateCall.params[2], 'failed');
  assert.equal(updateCall.params[6], true, 'recordFailureDetail must be true for a legitimate failure');
});

test('updateStatusByMetaId: no matching row is a no-op (send raced ahead of the webhook) — no update query at all', async () => {
  const db = fakeDb({ currentStatus: undefined });
  const result = await chatsRepo.updateStatusByMetaId(db, 'client-1', 'wamid.MISSING', 'sent', null, null);
  assert.equal(result, null);
  assert.equal(db.queries.some((q) => /^update messages set/.test(q.sql)), false);
});
