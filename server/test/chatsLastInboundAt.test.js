// Unit 0.1 (docs/ai-agent/IMPLEMENTATION.md): chats.last_inbound_at.
//
// Stubs only — nothing here may reach a real database (this project has no
// separate dev DB, and src/db/pool.js refuses any test that tries). The
// repository functions take `db` as a parameter, so a recording fake stands
// in for it. What these tests can and cannot prove:
//   - they prove WHICH statement runs, with WHICH parameters (the message's
//     own timestamp, never now()), and which functions never touch the column;
//   - they do NOT execute the SQL. greatest()/coalesce() behaviour and the
//     migration/backfill were verified once against a throwaway local
//     Postgres (see the unit's report), not against the shared database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const chatsRepo = require('../src/repositories/chatsRepo');
const migration = require('../src/db/migrations/086_chats_last_inbound_at');
const { parseArgs } = require('../scripts/backfill-last-inbound-at');

function fakeDb({ insertRows }) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      // The first statement of every function under test is the message insert.
      return calls.length === 1 ? { rows: insertRows } : { rows: [] };
    },
  };
}

const SENT_AT = new Date('2026-10-12T08:00:00.000Z');

test('insertInbound: last_inbound_at is set from the inserted row\'s own sent_at, not now()', async () => {
  const db = fakeDb({ insertRows: [{ id: 'm1', sent_at: SENT_AT }] });
  await chatsRepo.insertInbound(db, 'client-1', 'chat-1', {
    metaMessageId: 'wamid.1', body: 'hi', sentAt: SENT_AT.toISOString(), referral: null,
  });

  assert.equal(db.calls.length, 2, 'one insert, one chat update');
  const update = db.calls[1];
  assert.match(update.sql, /update chats/);
  assert.match(update.sql, /last_inbound_at\s*=\s*greatest\(/, 'must be monotonic via greatest()');
  assert.doesNotMatch(update.sql, /last_inbound_at\s*=\s*now\(\)/, 'must never be stamped with processing time');
  assert.deepEqual(update.params, ['client-1', 'chat-1', SENT_AT],
    'the value passed is the inserted row\'s sent_at (Meta\'s timestamp)');
});

test('insertInbound: a late-delivered older message passes ITS timestamp (greatest() then keeps the newer value)', async () => {
  const older = new Date('2026-10-11T08:00:00.000Z');
  const db = fakeDb({ insertRows: [{ id: 'm2', sent_at: older }] });
  await chatsRepo.insertInbound(db, 'client-1', 'chat-1', {
    metaMessageId: 'wamid.2', body: 'late', sentAt: older.toISOString(),
  });
  assert.equal(db.calls[1].params[2], older, 'the late message\'s own time is used, not the current time');
  assert.match(db.calls[1].sql, /greatest\(coalesce\(last_inbound_at, \$3::timestamptz\), \$3::timestamptz\)/);
});

test('insertInbound: a payload with no timestamp uses the row\'s stored sent_at (the DB default), still not a separate now()', async () => {
  const stored = new Date('2026-10-12T09:30:00.000Z');
  const db = fakeDb({ insertRows: [{ id: 'm3', sent_at: stored }] });
  await chatsRepo.insertInbound(db, 'client-1', 'chat-1', { metaMessageId: 'wamid.3', body: 'x', sentAt: null });
  assert.equal(db.calls[0].params[4], null, 'insert gets null and lets coalesce(..., now()) decide');
  assert.equal(db.calls[1].params[2], stored, 'the update reuses the stored sent_at so the two can never disagree');
});

test('insertInbound: a redelivered webhook (insert is a no-op) runs no update at all', async () => {
  const db = fakeDb({ insertRows: [] });
  const result = await chatsRepo.insertInbound(db, 'client-1', 'chat-1', {
    metaMessageId: 'wamid.dup', body: 'dup', sentAt: SENT_AT.toISOString(),
  });
  assert.equal(result, null);
  assert.equal(db.calls.length, 1, 'only the insert ran; last_inbound_at is untouched');
});

test('outbound send and Coexistence echo never touch last_inbound_at', async () => {
  const outDb = fakeDb({ insertRows: [{ id: 'o1', sent_at: SENT_AT }] });
  await chatsRepo.insertOutboundPending(outDb, 'client-1', 'chat-1', 'hello');
  const echoDb = fakeDb({ insertRows: [{ id: 'e1', sent_at: SENT_AT }] });
  await chatsRepo.insertEcho(echoDb, 'client-1', 'chat-1', { metaMessageId: 'wamid.e', body: 'from phone', sentAt: null });

  for (const call of [...outDb.calls, ...echoDb.calls]) {
    assert.doesNotMatch(call.sql, /last_inbound_at/, `statement must not reference last_inbound_at: ${call.sql.slice(0, 60)}`);
  }
  assert.ok(outDb.calls.length >= 1 && echoDb.calls.length >= 1);
});

test('migration 086: adds a nullable timestamptz column with no default, and drops it on down', () => {
  const ups = [];
  migration.up({ addColumns: (table, cols) => ups.push({ table, cols }) });
  assert.equal(ups.length, 1);
  assert.equal(ups[0].table, 'chats');
  assert.deepEqual(ups[0].cols, { last_inbound_at: { type: 'timestamptz' } });
  assert.equal('notNull' in ups[0].cols.last_inbound_at, false, 'nullable');
  assert.equal('default' in ups[0].cols.last_inbound_at, false, 'no default: null means unknown');

  const downs = [];
  migration.down({ dropColumns: (table, cols) => downs.push({ table, cols }) });
  assert.deepEqual(downs, [{ table: 'chats', cols: ['last_inbound_at'] }]);
});

test('migration 086 is the next free number: no other migration file shares it', () => {
  const fs = require('node:fs');
  const dir = path.join(__dirname, '..', 'src', 'db', 'migrations');
  const same = fs.readdirSync(dir).filter((f) => f.startsWith('086_'));
  assert.deepEqual(same, ['086_chats_last_inbound_at.js']);
});

test('backfill script: dry run is the default and batch size is validated', () => {
  assert.deepEqual(parseArgs([]), { apply: false, batchSize: 500 });
  assert.deepEqual(parseArgs(['--apply', '--batch-size=50']), { apply: true, batchSize: 50 });
  assert.throws(() => parseArgs(['--batch-size=0']));
  assert.throws(() => parseArgs(['--batch-size=abc']));
});
